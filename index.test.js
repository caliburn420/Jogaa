import assert from 'node:assert/strict';
import test from 'node:test';

const handlers = new Map();
const extensionSettings = {};
const chatCompletionSettings = {};
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
        chatCompletionSettings,
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

test('hidden output continues streaming after the hidden prefix is complete', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.hide = true;
    const body = request(true);
    handlers.get('request-ready')(body);
    const chunks = [
        JSON.stringify({ choices: [{ delta: { content: '{"value":"Prefix ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ta' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'il"}' } }] }),
    ];
    upstreamFactory = () => new Response(`${chunks.map(chunk => `data: ${chunk}\n\n`).join('')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
    });

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const visibleChunks = (await response.text()).split(/\n/)
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(5)).choices?.[0]?.delta?.content ?? '')
        .filter(Boolean);
    assert.deepEqual(visibleChunks, ['ta', 'il']);
});

test('uses only the fork native schema for Claude and replaces a passive fallback', () => {
    chatCompletionSettings.structured_prefill = 'off';
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.hide = false;
    const body = {
        chat_completion_source: 'claude',
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix ' },
        ],
        structured_prefill_schema_fallback: { type: 'object' },
        _structured_prefill_nl_token_fallback: '<NL>',
    };
    handlers.get('request-ready')(body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.json_schema, undefined);
    assert.equal(body.structured_prefill_schema?.properties?.value?.type, 'string');
    assert.equal(body.structured_prefill_schema_fallback, undefined);
    assert.equal(body._structured_prefill_nl_token_fallback, undefined);
    delete chatCompletionSettings.structured_prefill;
});

test('keeps the assistant message and supplies the fork Claude fallback while Off', () => {
    extensionSettings.prefillAlchemy.mode = 'off';
    const body = {
        chat_completion_source: 'claude',
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix ' },
        ],
    };
    handlers.get('request-ready')(body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.structured_prefill_schema_fallback?.properties?.value?.type, 'string');
    assert.equal(body._structured_prefill_nl_token_fallback, '<NL>');
});

test('optional continuation mode forces minimum reasoning for Gemini and reconstructs output', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.continuationOnly = true;
    extensionSettings.prefillAlchemy.hide = false;
    const body = {
        chat_completion_source: 'makersuite',
        model: 'gemini-3.6-flash',
        stream: false,
        reasoning_effort: 'high',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix: ' },
        ],
    };
    handlers.get('request-ready')(body);
    assert.equal(body.reasoning_effort, 'min');
    assert.equal(body.include_reasoning, false);
    assert.deepEqual(body.json_schema.value.propertyOrdering, ['continuation']);

    upstreamFactory = () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"continuation":"tail"}' } }],
    }), { headers: { 'content-type': 'application/json' } });
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(data.choices[0].message.content, 'Prefix: tail');
    extensionSettings.prefillAlchemy.continuationOnly = false;
});

test('default Gemini 3 mode keeps ordered prefix fields and selected reasoning', () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.continuationOnly = false;
    const body = {
        chat_completion_source: 'makersuite',
        model: 'gemini-3.6-flash',
        stream: false,
        reasoning_effort: 'high',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix: ' },
        ],
    };
    handlers.get('request-ready')(body);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.include_reasoning, true);
    assert.deepEqual(body.json_schema.value.propertyOrdering, ['p0', 'p1']);
});

test('optional continuation mode uses Claude strict-tool schema because native unwrapping is value-only', () => {
    chatCompletionSettings.structured_prefill = 'off';
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.continuationOnly = true;
    const body = {
        chat_completion_source: 'claude',
        model: 'claude-sonnet-4-6',
        stream: false,
        reasoning_effort: 'high',
        include_reasoning: true,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Prefix: ' },
        ],
    };
    handlers.get('request-ready')(body);
    assert.equal(body.reasoning_effort, 'min');
    assert.equal(body.include_reasoning, false);
    assert.equal(body.structured_prefill_schema, undefined);
    assert.deepEqual(body.json_schema.value.required, ['continuation']);
    assert.equal(body.json_schema.value.additionalProperties, false);
    extensionSettings.prefillAlchemy.continuationOnly = false;
    delete chatCompletionSettings.structured_prefill;
});

test('optional continuation mode uses strict OpenAI schema and reconstructs output', async () => {
    extensionSettings.prefillAlchemy.mode = 'on';
    extensionSettings.prefillAlchemy.continuationOnly = true;
    const body = request(false);
    body.reasoning_effort = 'high';
    body.include_reasoning = true;
    handlers.get('request-ready')(body);
    assert.equal(body.reasoning_effort, 'min');
    assert.equal(body.include_reasoning, false);
    assert.equal(body.json_schema.value.additionalProperties, false);
    assert.deepEqual(body.json_schema.value.required, ['continuation']);

    upstreamFactory = () => new Response(JSON.stringify({
        choices: [{ message: { content: '{"continuation":"tail"}' } }],
    }), { headers: { 'content-type': 'application/json' } });
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(data.choices[0].message.content, 'Prefix tail');
    extensionSettings.prefillAlchemy.continuationOnly = false;
});
