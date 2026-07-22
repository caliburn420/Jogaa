import {
    buildPrefillAlchemySchema,
    findTrailingAssistantPrefill,
    INCOMPATIBLE_SOURCES,
    isLikelyForcedReasoning,
    isUnsupportedModel,
    MODES,
    normalizeMode,
    shouldUsePrefillAlchemy,
    stripHiddenPrefill,
    transformNonStreamingResponse,
    unwrapPrefillAlchemyText,
} from './prefill-alchemy.js';

const MODULE_NAME = 'prefillAlchemy';
const META_KEY = '_prefill_alchemy_extension_meta';
const GENERATE_PATH = '/api/backends/chat-completions/generate';
const nativeFetch = globalThis.fetch.bind(globalThis);

const defaultSettings = Object.freeze({
    mode: MODES.OFF,
    autoProviders: {},
    autoDisableForForcedReasoning: false,
    hide: false,
    minLength: 900,
    newlineToken: '<NL>',
});

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const context = getContext();
    const allSettings = context.extensionSettings;
    if (!allSettings[MODULE_NAME]) {
        const legacy = context.chatCompletionSettings ?? {};
        allSettings[MODULE_NAME] = {
            ...structuredClone(defaultSettings),
            mode: normalizeMode(legacy.structured_prefill),
            autoProviders: structuredClone(legacy.structured_prefill_auto_providers ?? {}),
            autoDisableForForcedReasoning: !!legacy.structured_prefill_auto_disable_for_forced_reasoning,
            hide: !!legacy.structured_prefill_hide,
            minLength: Number(legacy.structured_prefill_min_length) || defaultSettings.minLength,
            newlineToken: String(legacy.structured_prefill_newline_token || defaultSettings.newlineToken),
        };
    }
    const settings = allSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    settings.mode = normalizeMode(settings.mode);
    settings.autoProviders = settings.autoProviders && typeof settings.autoProviders === 'object' ? settings.autoProviders : {};
    return settings;
}

function getProviderOptions() {
    return [...document.querySelectorAll('#chat_completion_source option')]
        .map(option => ({ value: String(option.value).toLowerCase(), label: option.textContent.trim() }))
        .filter(option => option.value && !INCOMPATIBLE_SOURCES.has(option.value));
}

function renderProviderToggles() {
    const container = document.getElementById('prefill_alchemy_providers');
    if (!container) return;
    const settings = getSettings();
    const normalizedProviders = {};
    for (const provider of getProviderOptions()) {
        normalizedProviders[provider.value] = Object.hasOwn(settings.autoProviders, provider.value)
            ? !!settings.autoProviders[provider.value]
            : true;
    }
    settings.autoProviders = normalizedProviders;
    container.textContent = '';
    for (const provider of getProviderOptions()) {
        if (settings.autoProviders[provider.value] === undefined) settings.autoProviders[provider.value] = true;
        const label = document.createElement('label');
        label.className = 'checkbox_label';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = settings.autoProviders[provider.value] !== false;
        input.addEventListener('change', () => {
            settings.autoProviders[provider.value] = input.checked;
            getContext().saveSettingsDebounced();
        });
        const text = document.createElement('span');
        text.textContent = provider.label || provider.value;
        label.append(input, text);
        container.append(label);
    }
}

function syncSettingsUi() {
    const settings = getSettings();
    const mode = document.getElementById('prefill_alchemy_mode');
    if (!mode) return;
    mode.value = settings.mode;
    document.getElementById('prefill_alchemy_hide').checked = settings.hide;
    document.getElementById('prefill_alchemy_min_length').value = String(settings.minLength);
    document.getElementById('prefill_alchemy_newline_token').value = settings.newlineToken;
    document.getElementById('prefill_alchemy_forced_reasoning').checked = settings.autoDisableForForcedReasoning;
    document.getElementById('prefill_alchemy_auto').hidden = settings.mode !== MODES.AUTO;
    document.getElementById('prefill_alchemy_options').hidden = settings.mode === MODES.OFF;
}

function bindSettingsUi() {
    const settings = getSettings();
    const save = () => getContext().saveSettingsDebounced();
    document.getElementById('prefill_alchemy_mode').addEventListener('change', event => {
        settings.mode = normalizeMode(event.target.value);
        syncSettingsUi();
        save();
    });
    document.getElementById('prefill_alchemy_hide').addEventListener('change', event => {
        settings.hide = event.target.checked;
        save();
    });
    document.getElementById('prefill_alchemy_forced_reasoning').addEventListener('change', event => {
        settings.autoDisableForForcedReasoning = event.target.checked;
        save();
    });
    document.getElementById('prefill_alchemy_min_length').addEventListener('change', event => {
        settings.minLength = Math.max(1, Math.min(10000, Number(event.target.value) || 900));
        event.target.value = String(settings.minLength);
        save();
    });
    document.getElementById('prefill_alchemy_newline_token').addEventListener('change', event => {
        settings.newlineToken = String(event.target.value || '<NL>').trim() || '<NL>';
        event.target.value = settings.newlineToken;
        save();
    });
}

async function addSettingsUi() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('prefill_alchemy')) return;
    const response = await nativeFetch(new URL('./settings.html', import.meta.url));
    container.insertAdjacentHTML('beforeend', await response.text());
    renderProviderToggles();
    bindSettingsUi();
    syncSettingsUi();
}

function onRequestReady(request) {
    const settings = getSettings();
    const context = getContext();
    const source = String(request.chat_completion_source ?? '').toLowerCase();
    const model = String(request.model ?? '');
    const nativeForkSupport = Object.hasOwn(context.chatCompletionSettings ?? {}, 'structured_prefill')
        || Boolean(request.structured_prefill_schema_fallback);
    const forcedReasoning = isLikelyForcedReasoning(source, model);
    const useAlchemy = shouldUsePrefillAlchemy(settings, source, model, forcedReasoning);

    // The fork already converted this request before extension hooks ran.
    if (request.structured_prefill_schema) return;

    if (useAlchemy && !request.json_schema && !INCOMPATIBLE_SOURCES.has(source)) {
        const prefill = findTrailingAssistantPrefill(request.messages);
        if (!prefill) return;
        const result = buildPrefillAlchemySchema(prefill.text, settings, source, model);
        if (!result) return;

        request.messages.splice(prefill.index, 1);
        const isClaude = source === 'claude' || model.toLowerCase().includes('claude');
        const isGemini3 = (source === 'makersuite' || source === 'vertexai')
            && /(?:^|\/)gemini-3(?:[.\d]*)(?:-|$)/i.test(model);
        if (isGemini3) {
            // Native assistant prefill bypasses the reasoning pass. Gemini 3.6 no longer
            // permits that final model turn, so request the closest supported behavior.
            request.reasoning_effort = 'min';
            request.include_reasoning = false;
        }
        if (nativeForkSupport && isClaude && result.rawSchema) {
            // Exact fork behavior: native Claude output_config.format only.
            request.structured_prefill_schema = result.rawSchema;
            request._structured_prefill_nl_token = result.nlToken;
            delete request.structured_prefill_schema_fallback;
            delete request._structured_prefill_nl_token_fallback;
        } else {
            // Stock SillyTavern fallback: its regular structured-output path.
            request.json_schema = result.schema;
        }

        request[META_KEY] = {
            text: prefill.text,
            hide: !!settings.hide,
            nlToken: result.nlToken,
            source,
            continuationOnly: !!result.continuationOnly,
        };
        return;
    }

    // Match the fork's native Claude fallback when structured prefill is disabled:
    // preserve the assistant prefill, but give the backend a schema it can retry with.
    if (!useAlchemy && source === 'claude' && !request.json_schema && !isUnsupportedModel(model)) {
        if (request.structured_prefill_schema_fallback) return;
        const lastIndex = Array.isArray(request.messages) ? request.messages.length - 1 : -1;
        const message = request.messages?.[lastIndex];
        if (message?.role !== 'assistant' || typeof message.content !== 'string' || !message.content) return;
        const result = buildPrefillAlchemySchema(message.content, settings, source, model);
        if (!result?.rawSchema) return;
        request.structured_prefill_schema_fallback = result.rawSchema;
        request._structured_prefill_nl_token_fallback = result.nlToken;
        request[META_KEY] = {
            text: message.content,
            hide: !!settings.hide,
            nlToken: result.nlToken,
            source,
        };
    }
}

function getBodyText(input, init) {
    if (typeof init?.body === 'string') return init.body;
    if (input instanceof Request && typeof input.body === 'string') return input.body;
    return null;
}

function isGenerateRequest(input) {
    try {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        return url.pathname === GENERATE_PATH;
    } catch {
        return false;
    }
}

function textTargets(data, source) {
    const targets = [];
    const add = (object, key) => {
        if (object && typeof object[key] === 'string') targets.push({ object, key });
    };
    if (source === 'claude') add(data?.delta, 'text');
    if (source === 'makersuite' || source === 'vertexai') {
        for (const part of data?.candidates?.[0]?.content?.parts ?? []) if (!part?.thought) add(part, 'text');
    }
    if (source === 'cohere') add(data?.delta?.message?.content, 'text');
    const choice = data?.choices?.[0];
    add(choice?.delta, 'content');
    add(choice?.message, 'content');
    add(choice, 'text');
    if (Array.isArray(choice?.delta?.content)) {
        for (const part of choice.delta.content) add(part, 'text');
    }
    return targets;
}

function normalizeClaudeToolEvent(data) {
    const block = data?.content_block;
    if (data?.type === 'content_block_start' && block?.type === 'tool_use' && block?.name === 'prefill_alchemy') {
        data.content_block = { type: 'text', text: '' };
    }
    if (data?.delta?.type === 'input_json_delta' && typeof data.delta.partial_json === 'string') {
        data.delta = { type: 'text_delta', text: data.delta.partial_json };
    }
    if (data?.type === 'message_delta' && data?.delta?.stop_reason === 'tool_use') data.delta.stop_reason = 'end_turn';
    return data;
}

function syntheticTextEvent(source, text) {
    if (source === 'claude') return { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
    if (source === 'makersuite' || source === 'vertexai') return { candidates: [{ content: { parts: [{ text }] } }] };
    if (source === 'cohere') return { delta: { message: { content: { text } } } };
    return { choices: [{ delta: { content: text } }] };
}

function getHiddenStreamingText(raw, meta) {
    const decoded = unwrapPrefillAlchemyText(raw, { ...meta, hide: false });
    const template = String(meta.text ?? '').replace(/\r\n?/g, '\n');
    const keep = /\[\[\s*keep\s*\]\]/i.exec(template);
    const hiddenTemplate = keep ? template.slice(0, keep.index) : template;
    const literal = hiddenTemplate.replace(/\[\[[^\]]+?\]\]/g, '');
    const normalizeQuotes = value => String(value)
        .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
        .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'");
    const normalizedText = normalizeQuotes(decoded);
    const normalizedLiteral = normalizeQuotes(literal);
    const pending = normalizedLiteral.startsWith(normalizedText) && normalizedText.length < normalizedLiteral.length;
    return { pending, text: pending ? '' : stripHiddenPrefill(decoded, meta.text) };
}

function wrapStreamingResponse(response, meta) {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let raw = '';
    let clean = '';
    let flushedHidden = false;

    const processFrame = frame => {
        if (!frame.trim()) return frame;
        const lines = frame.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('data:')) continue;
            const payload = lines[i].slice(5).trimStart();
            if (!payload || payload === '[DONE]') continue;
            try {
                const data = meta.source === 'claude' ? normalizeClaudeToolEvent(JSON.parse(payload)) : JSON.parse(payload);
                for (const target of textTargets(data, meta.source)) {
                    raw += target.object[target.key];
                    if (meta.hide) {
                        const hidden = getHiddenStreamingText(raw, meta);
                        if (hidden.pending) {
                            target.object[target.key] = '';
                        } else {
                            target.object[target.key] = hidden.text.startsWith(clean) ? hidden.text.slice(clean.length) : hidden.text;
                            clean = hidden.text;
                        }
                    } else {
                        const next = unwrapPrefillAlchemyText(raw, meta);
                        target.object[target.key] = next.startsWith(clean) ? next.slice(clean.length) : next;
                        clean = next;
                    }
                }
                lines[i] = `data: ${JSON.stringify(data)}`;
            } catch {
                // Preserve malformed or non-JSON SSE payloads unchanged.
            }
        }
        return lines.join('\n');
    };

    const flushHidden = controller => {
        if (!meta.hide || flushedHidden || !raw) return;
        flushedHidden = true;
        let finalText = getHiddenStreamingText(raw, meta).text;
        if (finalText === '' && !raw.trimStart().startsWith('{')) finalText = stripHiddenPrefill(raw, meta.text);
        const remaining = finalText.startsWith(clean) ? finalText.slice(clean.length) : finalText;
        if (remaining) controller.enqueue(encoder.encode(`data: ${JSON.stringify(syntheticTextEvent(meta.source, remaining))}\n\n`));
    };

    const stream = new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                buffer += decoder.decode();
                if (buffer) controller.enqueue(encoder.encode(processFrame(buffer) + '\n\n'));
                flushHidden(controller);
                controller.close();
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
                const isDoneFrame = frame.split(/\r?\n/).some(line => line.startsWith('data:') && line.slice(5).trim() === '[DONE]');
                if (isDoneFrame) flushHidden(controller);
                controller.enqueue(encoder.encode(processFrame(frame) + '\n\n'));
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function wrapNonStreamingResponse(response, meta) {
    const data = await response.clone().json();
    const transformed = transformNonStreamingResponse(data, meta);
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.delete('content-length');
    return new Response(JSON.stringify(transformed), { status: response.status, statusText: response.statusText, headers });
}

globalThis.fetch = async function prefillAlchemyFetch(input, init) {
    if (!isGenerateRequest(input)) return nativeFetch(input, init);
    const bodyText = getBodyText(input, init);
    if (!bodyText) return nativeFetch(input, init);
    let body;
    try {
        body = JSON.parse(bodyText);
    } catch {
        return nativeFetch(input, init);
    }
    const meta = body[META_KEY];
    if (!meta) return nativeFetch(input, init);
    delete body[META_KEY];
    const nextInit = { ...(init ?? {}), body: JSON.stringify(body) };
    const response = await nativeFetch(input, nextInit);
    if (!response.ok) return response;
    try {
        return body.stream ? wrapStreamingResponse(response, meta) : await wrapNonStreamingResponse(response, meta);
    } catch (error) {
        console.error('Prefill Alchemy failed to transform the response.', error);
        return response;
    }
};

(async function init() {
    const context = getContext();
    getSettings();
    await addSettingsUi();
    context.eventSource.on(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onRequestReady);
    context.eventSource.on(context.eventTypes.CHATCOMPLETION_SOURCE_CHANGED, renderProviderToggles);
    context.saveSettingsDebounced();
})();
