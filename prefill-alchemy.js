export const MODES = Object.freeze({ OFF: 'off', AUTO: 'auto', ON: 'on' });

export const INCOMPATIBLE_SOURCES = new Set([
    'ai21',
    'deepseek',
    'siliconflow',
    'cometapi',
    'nanogpt',
]);

export function normalizeMode(value) {
    if (value === true) return MODES.ON;
    if (value === false || value == null) return MODES.OFF;
    const mode = String(value).toLowerCase();
    return Object.values(MODES).includes(mode) ? mode : MODES.OFF;
}

export function supportsClaudeNativeAssistantPrefill(model) {
    const id = String(model ?? '').toLowerCase();
    if (!id.includes('claude')) return false;
    if (/claude-(?:sonnet|opus|haiku)-4-(?:6|[7-9]|[1-9]\d)(?:$|[^0-9])/.test(id)) return false;
    if (/claude-(?:sonnet|opus|haiku)-[5-9]\d*(?:$|[^0-9])/.test(id)) return false;
    return true;
}

export function isUnsupportedModel(model) {
    return String(model ?? '').toLowerCase().includes('claude-fable');
}

export function isLikelyForcedReasoning(source, model, request = {}) {
    const id = String(model ?? '').toLowerCase();
    const src = String(source ?? '').toLowerCase();
    if (request.reasoning_effort === 'none' || request.reasoning_effort === 'disabled') return false;
    const providerPrefix = '(?:^|/)';
    if (new RegExp(`${providerPrefix}(?:gpt-4\\.5|o1|o3)(?:-|$)`).test(id)) return true;
    if (new RegExp(`${providerPrefix}(?:gemini-2\\.0-flash-thinking-exp|gemini-2\\.0-pro-exp|gemini-2\\.5|gemini-3(?:\\.1)?)(?:-|$)`).test(id)) return true;
    if (/(?:^|\/)(?:deepseek-r1|qwq)(?:-|$)/.test(id)) return true;
    if (src === 'minimax' && id !== 'minimax-m3') return true;
    return src === 'deepseek' && id.includes('reasoner');
}

export function shouldUsePrefillAlchemy(settings, source, model, request = {}) {
    const mode = normalizeMode(settings.mode);
    const src = String(source ?? '').toLowerCase();
    if (mode === MODES.OFF || INCOMPATIBLE_SOURCES.has(src) || isUnsupportedModel(model)) return false;
    if (request.json_schema) return false;
    if (mode === MODES.ON) return true;
    if (settings.autoProviders?.[src] === false) return false;
    if (settings.autoDisableForForcedReasoning && isLikelyForcedReasoning(src, model, request)) return false;
    return !String(model ?? '').toLowerCase().includes('claude') || !supportsClaudeNativeAssistantPrefill(model);
}

export function findTrailingAssistantPrefill(messages) {
    if (!Array.isArray(messages)) return null;
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUser = i;
            break;
        }
    }
    for (let i = messages.length - 1; i > lastUser; i--) {
        const message = messages[i];
        if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
            return { index: i, text: message.content };
        }
    }
    return null;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapePrefixLiteral(value) {
    return escapeRegex(value).replace(/"/g, '(?:\\\\)*"');
}

function anyCharPattern() {
    return '(?:.|\\n)';
}

function patternMode(source, model) {
    const src = String(source ?? '').toLowerCase();
    const id = String(model ?? '').toLowerCase();
    return src === 'claude' || src === 'anthropic' || (src === 'openrouter' && (id.startsWith('anthropic/') || id.includes('claude')))
        ? 'anthropic'
        : 'default';
}

function curlyQuoteLiteralsOutsideSlots(template) {
    const slot = /\[\[[^\]]+?\]\]/g;
    let output = '';
    let last = 0;
    let open = true;
    const transform = text => String(text).replace(/"/g, () => open ? (open = false, '\u201c') : (open = true, '\u201d'));
    for (const match of String(template ?? '').matchAll(slot)) {
        output += transform(String(template).slice(last, match.index));
        output += match[0];
        last = match.index + match[0].length;
    }
    return output + transform(String(template ?? '').slice(last));
}

function buildSlotRegex(body, mode) {
    const value = String(body ?? '').trim();
    const lower = value.toLowerCase();
    const any = anyCharPattern();
    let match = /^(?:w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(lower);
    if (match) {
        const a = Math.max(1, Math.min(2000, Number(match[1])));
        const b = match[2] == null ? a : Math.max(1, Math.min(2000, Number(match[2])));
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        const word = '[^\\s,<>]+[,\\.!\\?;:\'"\\)\\]\\}~-]*';
        const separator = '[\\t ]+';
        if (mode === 'anthropic') {
            let result = '';
            const capped = Math.min(max, 40);
            for (let i = 0; i < min; i++) result += i === 0 ? word : separator + word;
            for (let i = min; i < capped; i++) result += `(?:${separator}${word})?`;
            if (max > 40) result += `(?:${separator}${word})*`;
            return result;
        }
        return `${word}(?:${separator}${word}){${Math.max(0, min - 1)},${Math.max(0, max - 1)}}`;
    }
    match = /^(?:opt|options)\s*:\s*(.+?)\s*$/i.exec(value);
    if (match) {
        const options = match[1].split(/[|,]/).map(x => x.trim()).filter(Boolean);
        return options.length ? `(?:${options.map(escapeRegex).join('|')})` : '[^\\s,<>]+';
    }
    match = /^(?:re|regex)\s*:\s*(.+?)\s*$/i.exec(value);
    if (match) {
        let expression = match[1].trim();
        const wrapped = expression.match(/^\/(.+)\/([a-z]*)$/);
        if (wrapped) expression = wrapped[1];
        expression = expression.replace(/^\^+/, '').replace(/\$+$/, '');
        if (!expression) return `${any}*`;
        if (mode === 'anthropic' && (/[{}]/.test(expression) || /\\S/.test(expression))) return `${any}*`;
        return `(?:${expression})`;
    }
    if (/^free$/i.test(value)) return `${any}+`;
    if (/^keep$/i.test(value)) return '(?:)';
    return '[^\\s,<>]+';
}

function buildPrefixRegex(template, mode) {
    const slot = /\[\[([^\]]+?)\]\]/g;
    let output = '';
    let last = 0;
    let match;
    while ((match = slot.exec(template)) !== null) {
        output += escapePrefixLiteral(template.slice(last, match.index));
        output += buildSlotRegex(match[1], mode);
        last = match.index + match[0].length;
    }
    return output + escapePrefixLiteral(template.slice(last));
}

function buildGeminiSchema(prefillText) {
    const normalized = prefillText.replace(/\r\n?/g, '\n');
    const segments = [];
    const slot = /\[\[([^\]]+?)\]\]/g;
    let last = 0;
    let match;
    while ((match = slot.exec(normalized)) !== null) {
        if (match.index > last) segments.push({ type: 'literal', text: normalized.slice(last, match.index) });
        const body = match[1].trim();
        const options = /^(?:opt|options)\s*:\s*(.+)$/i.exec(body);
        if (/^keep$/i.test(body)) segments.push({ type: 'keep' });
        else if (options) segments.push({ type: 'options', values: options[1].split(/[|,]/).map(x => x.trim()).filter(Boolean) });
        else segments.push({ type: 'free', description: `Fill in text for [[${body}]].` });
        last = match.index + match[0].length;
    }
    if (last < normalized.length) segments.push({ type: 'literal', text: normalized.slice(last) });

    const properties = {};
    const required = [];
    const propertyOrdering = [];
    let index = 0;
    for (const segment of segments) {
        if (segment.type === 'keep') continue;
        const name = `p${index++}`;
        required.push(name);
        propertyOrdering.push(name);
        properties[name] = segment.type === 'literal'
            ? { type: 'string', enum: [segment.text] }
            : segment.type === 'options'
                ? { type: 'string', enum: segment.values.length ? segment.values : [''] }
                : { type: 'string', description: segment.description };
    }
    const continuation = `p${index}`;
    required.push(continuation);
    propertyOrdering.push(continuation);
    properties[continuation] = { type: 'string', description: 'Continue the response naturally after the prefix.' };
    return {
        schema: {
            name: 'prefill_alchemy',
            description: 'Constrain output so it begins with a prefix and continues with additional content.',
            strict: true,
            value: { type: 'object', properties, required, propertyOrdering },
        },
        rawSchema: null,
        nlToken: '',
        multiField: true,
    };
}

export function buildPrefillAlchemySchema(prefillText, settings, source, model) {
    if (!prefillText || !prefillText.trim()) return null;
    const src = String(source ?? '').toLowerCase();
    if (src === 'makersuite' || src === 'vertexai') return buildGeminiSchema(prefillText);

    const mode = patternMode(src, model);
    const minimum = Math.max(1, Math.min(10000, Number(settings.minLength) || 900));
    let nlToken = String(settings.newlineToken || '<NL>').trim();
    if (!nlToken || /[\r\n]/.test(nlToken)) nlToken = '<NL>';
    const normalized = prefillText.replace(/\r\n?/g, '\n');
    if (normalized.includes(nlToken)) {
        for (let i = 2; i <= 25; i++) {
            if (!normalized.includes(`<NL${i}>`)) {
                nlToken = `<NL${i}>`;
                break;
            }
        }
    }
    const wire = curlyQuoteLiteralsOutsideSlots(prefillText).replace(/\r\n?/g, '\n').replace(/\n/g, nlToken);
    let prefix = buildPrefixRegex(wire, mode);
    const escapedToken = escapeRegex(nlToken);
    prefix = prefix.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
    const any = anyCharPattern();
    const pattern = mode === 'anthropic'
        ? `^(?:${prefix})${any}*[^\\s]${any}*$`
        : `^(?:${prefix})${any}{${minimum},}$`;
    new RegExp(pattern);
    const rawSchema = {
        type: 'object',
        properties: {
            value: {
                type: 'string',
                description: 'Full assistant reply text. Must start with the required prefix and then continue.',
                pattern,
            },
        },
        required: ['value'],
        additionalProperties: false,
    };
    return {
        schema: {
            name: 'prefill_alchemy',
            description: 'Constrain output so it begins with a prefix and continues with additional content.',
            strict: true,
            value: rawSchema,
        },
        rawSchema,
        nlToken,
        multiField: false,
    };
}

function extractJsonStringField(rawText, fieldName) {
    const safe = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    const match = new RegExp(`"${safe}"\\s*:\\s*"`).exec(rawText);
    if (!match) return null;
    let output = '';
    let escaped = false;
    let unicode = '';
    for (let i = match.index + match[0].length; i < rawText.length; i++) {
        const char = rawText[i];
        if (unicode) {
            unicode += char;
            if (unicode.length === 5) {
                if (/^u[0-9a-f]{4}$/i.test(unicode)) output += String.fromCharCode(Number.parseInt(unicode.slice(1), 16));
                unicode = '';
            }
            continue;
        }
        if (escaped) {
            escaped = false;
            if (char === 'u') unicode = 'u';
            else output += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' })[char] ?? char;
            continue;
        }
        if (char === '\\') escaped = true;
        else if (char === '"') break;
        else output += char;
    }
    return output;
}

function normalizeQuotes(value) {
    return String(value).replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"').replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'");
}

export function stripHiddenPrefill(text, template) {
    if (!text || !template) return text;
    const normalized = text.replace(/\r\n?/g, '\n');
    const source = template.replace(/\r\n?/g, '\n');
    const keep = /\[\[\s*keep\s*\]\]/i.exec(source);
    const hiddenTemplate = keep ? source.slice(0, keep.index) : source;
    const literal = hiddenTemplate.replace(/\[\[[^\]]+?\]\]/g, '');
    if (normalized.startsWith(literal)) return normalized.slice(literal.length);
    if (normalizeQuotes(normalized).startsWith(normalizeQuotes(literal))) return normalized.slice(literal.length);
    return normalized;
}

export function unwrapPrefillAlchemyText(rawText, meta = {}) {
    if (typeof rawText !== 'string' || !rawText.length) return rawText;
    const decode = value => meta.nlToken ? value.split(meta.nlToken).join('\n') : value;
    const finish = value => meta.hide ? stripHiddenPrefill(decode(value), meta.text) : decode(value);
    try {
        const parsed = JSON.parse(rawText);
        if (typeof parsed?.value === 'string') return finish(parsed.value);
        const keys = Object.keys(parsed ?? {}).filter(key => /^p\d+$/.test(key)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        if (keys.length) return finish(keys.map(key => typeof parsed[key] === 'string' ? parsed[key] : '').join(''));
    } catch {
        // Partial JSON is expected while streaming.
    }
    const single = extractJsonStringField(rawText, 'value');
    if (single !== null) return finish(single);
    let multi = '';
    for (let i = 0; i < 100; i++) {
        const value = extractJsonStringField(rawText, `p${i}`);
        if (value === null) break;
        multi += value;
    }
    if (multi) return finish(multi);
    return rawText.trimStart().startsWith('{') ? '' : finish(rawText);
}

export function transformNonStreamingResponse(data, meta) {
    if (!data || typeof data !== 'object') return data;
    let clean = null;
    if (data.structured_prefill_unwrapped) {
        const content = data?.choices?.[0]?.message?.content;
        clean = meta.hide ? stripHiddenPrefill(content, meta.text) : content;
    } else {
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content) clean = unwrapPrefillAlchemyText(content, meta);
        if (clean == null || clean === '') {
            const tool = data?.content?.find?.(block => block?.type === 'tool_use' && block?.name === 'prefill_alchemy');
            if (tool?.input && typeof tool.input === 'object') clean = unwrapPrefillAlchemyText(JSON.stringify(tool.input), meta);
        }
    }
    if (typeof clean === 'string') {
        data.choices ??= [{}];
        data.choices[0] ??= {};
        data.choices[0].message ??= {};
        data.choices[0].message.content = clean;
        if (Array.isArray(data.content)) data.content = [{ type: 'text', text: clean }];
    }
    return data;
}
