import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildPrefillAlchemySchema,
    findTrailingAssistantPrefill,
    MODES,
    shouldUsePrefillAlchemy,
    transformNonStreamingResponse,
    unwrapPrefillAlchemyText,
} from './prefill-alchemy.js';

const settings = {
    mode: MODES.AUTO,
    autoProviders: {},
    autoDisableForForcedReasoning: false,
    hide: false,
    minLength: 5,
    newlineToken: '<NL>',
};

test('finds only a trailing assistant prefill after the last user message', () => {
    const messages = [
        { role: 'assistant', content: 'old' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'instruction' },
        { role: 'assistant', content: 'Prefix: ' },
    ];
    assert.deepEqual(findTrailingAssistantPrefill(messages), { index: 3, text: 'Prefix: ' });
    assert.equal(findTrailingAssistantPrefill(messages.slice(0, 3)), null);
});

test('Auto prefers native prefill before Claude 4.6 and Prefill Alchemy at 4.6', () => {
    assert.equal(shouldUsePrefillAlchemy(settings, 'claude', 'claude-sonnet-4-5'), false);
    assert.equal(shouldUsePrefillAlchemy(settings, 'claude', 'claude-sonnet-4-6'), true);
    assert.equal(shouldUsePrefillAlchemy({ ...settings, mode: MODES.ON }, 'claude', 'claude-sonnet-4-5'), true);
    assert.equal(shouldUsePrefillAlchemy(settings, 'nanogpt', 'anything'), false);
});

test('Auto can skip the same forced-reasoning model families as core', () => {
    const guarded = { ...settings, autoDisableForForcedReasoning: true };
    assert.equal(shouldUsePrefillAlchemy(guarded, 'makersuite', 'gemini-3.1-pro'), false);
    assert.equal(shouldUsePrefillAlchemy(guarded, 'openrouter', 'openai/o3-pro'), false);
    assert.equal(shouldUsePrefillAlchemy(guarded, 'minimax', 'minimax-m2.5'), false);
    assert.equal(shouldUsePrefillAlchemy(guarded, 'minimax', 'minimax-m3'), true);
});

test('builds a single-field schema with slots and encoded newlines', () => {
    const result = buildPrefillAlchemySchema('Status: [[opt:yes|no]]\nBody: ', settings, 'openai', 'gpt-5.6');
    assert.equal(result.nlToken, '<NL>');
    assert.equal(result.schema.name, 'prefill_alchemy');
    const pattern = new RegExp(result.schema.value.properties.value.pattern);
    assert.equal(pattern.test('Status: yes<NL>Body: hello'), true);
    assert.equal(pattern.test('Wrong: yes<NL>Body: hello'), false);
});

test('builds and unwraps Gemini ordered fields', () => {
    const result = buildPrefillAlchemySchema('A[[opt:B|C]]D', settings, 'makersuite', 'gemini-3.5-pro');
    assert.deepEqual(result.schema.value.propertyOrdering, ['p0', 'p1', 'p2', 'p3']);
    assert.equal(unwrapPrefillAlchemyText('{"p0":"A","p1":"B","p2":"D","p3":"tail"}', { text: '', hide: false, nlToken: '' }), 'ABDtail');
});

test('unwraps partial JSON and restores newlines', () => {
    const raw = '{"value":"Prefix<NL>continu';
    assert.equal(unwrapPrefillAlchemyText(raw, { text: 'Prefix\n', hide: false, nlToken: '<NL>' }), 'Prefix\ncontinu');
});

test('converts stock Claude forced-tool output into assistant text', () => {
    const response = {
        choices: [{ message: { content: '' } }],
        content: [{ type: 'tool_use', name: 'prefill_alchemy', input: { value: 'Prefix tail' } }],
    };
    transformNonStreamingResponse(response, { text: 'Prefix ', hide: true, nlToken: '<NL>' });
    assert.equal(response.choices[0].message.content, 'tail');
    assert.deepEqual(response.content, [{ type: 'text', text: 'tail' }]);
});

test('keeps this fork native Claude output and applies hide', () => {
    const response = {
        structured_prefill_unwrapped: true,
        choices: [{ message: { content: 'Prefix tail' } }],
    };
    transformNonStreamingResponse(response, { text: 'Prefix ', hide: true, nlToken: '<NL>' });
    assert.equal(response.choices[0].message.content, 'tail');
});
