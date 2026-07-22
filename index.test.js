import assert from 'node:assert/strict';
import test from 'node:test';

const handlers = new Map();
const extensionSettings = {};
let sentBody = null;
let upstreamFactory = () => new Response('{}', { headers: { 'content-type': 'application/json' } });

globalThis.location = new URL('http://localhost:8000/');
globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
};
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings,
        chatCompletionSettings: {},
        saveSettingsDebounced: () => {},
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'request-ready',
            CHATCOMPLETION_SOURCE_CHANGED: 'source-changed',
        },
        eventSource: {
            on: (event, handler) => handlers.set(event, handler),
        },
    }),
};
globalThis.fetch = async (_input, init) => {
    sentBody = JSON.parse(init.body);
    return upstreamFactory(sentBody);
};

await import('./index.js');
await new Promise(resolve => setTimeout(resolve, 0));

function request(stream = false) {
    return {
        chat_completion_source: 'openai',
        model: 'gpt-5.6',
        stream,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix ' },
        ],
    };
}

test('request hook moves the assistant prefill into a schema and unwraps a JSON response', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    const body = request(false);
    handlers.get('request-ready')(body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.json_schema.name, 'prefill_alchemy');

    upstreamFactory = () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"value":"Prefix tail"}' } }],
    }), { headers: { 'content-type': 'application/json' } });

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(data.choices[0].message.content, 'Prefix tail');
    assert.equal(sentBody._prefill_alchemy_extension_meta, undefined);
});

test('stream adapter unwraps JSON deltas before SillyTavern sees them', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.hide = false;
    const body = request(true);
    handlers.get('request-ready')(body);
    const first = JSON.stringify({ choices: [{ delta: { content: '{"value":"Prefix ' } }] });
    const second = JSON.stringify({ choices: [{ delta: { content: 'tail"}' } }] });
    upstreamFactory = () => new Response(`data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
    });

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const payloads = (await response.text()).split(/\n/)
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(5)))
        .map(data => data.choices?.[0]?.delta?.content ?? '')
        .join('');
    assert.equal(payloads, 'Prefix tail');
});

test('hidden streaming output is emitted before the DONE marker', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.hide = true;
    const body = request(true);
    handlers.get('request-ready')(body);
    const first = JSON.stringify({ choices: [{ delta: { content: '{"value":"Prefix ' } }] });
    const second = JSON.stringify({ choices: [{ delta: { content: 'tail"}' } }] });
    upstreamFactory = () => new Response(`data: ${first}\n\ndata: ${second}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
    });

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const visibleIndex = text.indexOf('"content":"tail"');
    const doneIndex = text.indexOf('data: [DONE]');
    assert.ok(visibleIndex >= 0);
    assert.ok(doneIndex > visibleIndex);
    assert.equal(text.includes('"content":"Prefix '), false);
});
