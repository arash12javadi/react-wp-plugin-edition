/**
 * Spending the AI key saved on Settings → Integrations → AI.
 *
 * `server/integrationConfig.mjs` owns what an `ai_config` row *is* and how a key is proven to work
 * (`POST /api/integrations/ai/test`). This module owns the other half: the one generation call a
 * plugin server route makes with that key. It exists because three plugins generate text — Section
 * Refine (`plugins/rwp-page-builder`), the snippets assistant (`plugins/rwp-code-snippets`) and the
 * chat assistant (`plugins/rwp-chat`) — and each of them used to carry its own copy of the Google
 * request shape, its own JSON schema and its own error sentences. Adding a second provider to the
 * card would then have meant three edits per provider, so the provider lives here once.
 *
 * A caller passes the resolved row, a system prompt, a conversation, a schema and a temperature;
 * which URL, which body shape and which sentence a failure becomes is decided here. Four provider
 * types are implemented: Google Gemini (`x-goog-api-key`, `systemInstruction`, `contents`,
 * `responseSchema`), OpenAI (`Authorization: Bearer`, `messages`, `response_format.json_schema`),
 * Anthropic (`x-api-key`, `anthropic-version`, `system`, `messages`) and any OpenAI-compatible
 * service, which shares OpenAI's shape but takes its address and model from the `ai_config` row.
 *
 * Nothing here reads `process.env`: the key arrives from the row `server/plugins.mjs` resolved for
 * the request, which is why a plugin never has to know how the server reaches `system_settings`.
 *
 * Plain ESM, like `integrationConfig.mjs`, because `server.mjs`, `api/plugins.ts` and the plugin
 * folders all load it directly — none of them can import TypeScript.
 */
import {
  AI_CONFIG_KEY, AI_PROVIDERS, aiConfigFrom, aiProviderName, isAiConfigured,
} from './integrationConfig.mjs';
import { readIntegrationRows } from './integrationSettings.mjs';

export { isAiConfigured };

/**
 * The model used when the AI card's Model field is empty, per provider.
 *
 * In step with `aiProviderModels` in `src/lib/integrations.ts` (that list is what the card suggests);
 * this is the one actually called, so a site that never touches the field gets a current model rather
 * than a hard-coded name from a year ago.
 */
export const DEFAULT_AI_MODELS = {
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  // A custom provider names its own models; guessing one would send a request that cannot work.
  'openai-compatible': '',
};

/** Where an administrator fixes a key or a model. Named in every error, so the answer is actionable. */
export const AI_SETTINGS_HINT = 'Settings → Integrations → AI';

/** The provider of a row, narrowed to what this module can call. `aiConfigFrom` already does this. */
const providerOf = (config) => (AI_PROVIDERS.includes(String(config?.provider)) ? String(config.provider) : 'gemini');

/**
 * A retired model's replacement, remembered for this process per provider.
 *
 * Providers retire model names on their own schedule and their error names the new one. Retrying
 * once with it keeps a site working between deployments; the row is still what a new request starts
 * from, so an administrator who saves a model always gets that model.
 */
const suggestedModels = { gemini: '', openai: '', anthropic: '', 'openai-compatible': '' };

/**
 * The model a request will use: the saved one, else a name a provider's error suggested, else the
 * plugin's own default, else ours. Exported so a status route reports the same name it would call.
 */
export const aiModelFor = (config, fallback = '') => {
  const saved = String(config?.model || '').trim();
  if (saved) return saved;
  const provider = providerOf(config);
  return String(suggestedModels[provider] || fallback || DEFAULT_AI_MODELS[provider] || '').trim();
};

/** Thrown by every failure below: `status` is what the plugin route answers with, `message` is shown. */
export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

/**
 * The stored `ai_config`, read the way the rest of the server reads it.
 *
 * The options are `readIntegrationRows`' own (`readSetting`, `databaseUrl`, `dbType`, `supabaseUrl`,
 * `supabaseKey`, `env`), forwarded untouched, so a caller that has a database adapter passes it and a
 * caller that has only the Supabase pair passes that. `readable` is carried out because a site whose
 * server cannot reach `system_settings` at all should be told so rather than told it has no key.
 */
export const readAiConfig = async (options = {}) => {
  const rows = await readIntegrationRows([AI_CONFIG_KEY], options);
  return {
    ...aiConfigFrom(rows.settings[AI_CONFIG_KEY]),
    readable: rows.readable === true,
    error: rows.error || '',
  };
};

/** What the Plugins screens display: presence, provider and the model that would be called. */
export const describeAiStatus = (config) => {
  const provider = providerOf(config);
  const configured = isAiConfigured(config);
  return {
    configured,
    provider,
    providerName: aiProviderName(config),
    model: configured ? aiModelFor(config) : '',
    hint: AI_SETTINGS_HINT,
  };
};


// -- The request -----------------------------------------------------------------------------------
//
// A plugin sends the same four things whatever the provider: a system prompt, a conversation, the
// JSON schema the answer must match, and a temperature. The providers disagree about all of it, so
// each shape is built here once — including the two that merely share OpenAI's.

/**
 * The schema with every `type` re-cased, for the provider that is about to receive it.
 *
 * The plugins write schemas the way Google's documentation does (`type: 'OBJECT'`), while OpenAI's
 * structured outputs want JSON Schema's lower case. Only `type` differs — `properties`, `items`,
 * `required` and `enum` mean the same thing on both sides — so this recurses and rewrites that one
 * key rather than keeping two schemas per call and letting them drift.
 */
const caseSchemaTypes = (schema, upper) => {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const mapped = { ...schema };
  if (typeof schema.type === 'string') mapped.type = upper ? schema.type.toUpperCase() : schema.type.toLowerCase();
  if (schema.properties && typeof schema.properties === 'object') {
    mapped.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, caseSchemaTypes(value, upper)]),
    );
  }
  if (schema.items) mapped.items = caseSchemaTypes(schema.items, upper);
  return mapped;
};

/** True for the two provider types that take OpenAI's `messages` / `choices` shape. */
const usesOpenAiShape = (provider) => provider === 'openai' || provider === 'openai-compatible';

/** The conversation in the shape a provider takes it: one user/assistant turn per entry. */
const turnsFor = (messages, provider) => messages.map((message) => {
  const assistant = message?.role === 'assistant' || message?.role === 'model';
  const text = String(message?.text ?? '');
  if (provider === 'gemini') return { role: assistant ? 'model' : 'user', parts: [{ text }] };
  return { role: assistant ? 'assistant' : 'user', content: text };
});

/**
 * The API root of a custom provider, with the endpoint appended.
 *
 * The card asks for the part before `/chat/completions` and `aiConfigFrom` strips a pasted endpoint,
 * so this join is the only place that knows the path.
 */
const endpointFor = (baseUrl, path) => {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return base ? `${base}${path}` : '';
};

/**
 * The JSON instruction a provider without structured outputs is given instead.
 *
 * Anthropic has no `response_format` at all and a custom service cannot be relied on to implement
 * it, so the schema goes into the prompt, and the answer is still shaped like the one the plugin
 * validates. Where in the prompt it goes differs by caller: Anthropic is given it in `system`, an
 * OpenAI-shaped service on its last turn (see `requestFor`, which explains why).
 */
const jsonInstruction = (schema) => {
  const json = JSON.stringify(caseSchemaTypes(schema || {}, false));
  const lead = '\n\nReply with a single JSON object only — no prose and no code fences';
  return json && json !== '{}' ? `${lead} — matching this JSON schema exactly:\n${json}` : `${lead}.`;
};

/**
 * The URL, the headers and the body for one generation, for the provider the card is set to.
 *
 * The two OpenAI-shaped providers do not get the same body. OpenAI itself is sent a `json_schema`,
 * its own structured outputs, and that is the only place the field is sent at all. A custom service
 * is told in the prompt instead — on the last turn, and only there:
 *
 *  - `json_schema` is silently ignored by a service that does not implement it, which answers in
 *    prose: a 200 the plugin can only reject.
 *  - `json_object` is implemented, but not always implemented well. With the schema stated in the
 *    system prompt, DeepSeek's `deepseek-flash` answers a multi-turn request with a message that is
 *    nothing but spaces and `finish_reason: "stop"` — again a 200 no plugin can parse; without
 *    `response_format` at all, the same request is answered in prose.
 *  - Stating it twice, in the system prompt and on the last turn, is no better: measured against
 *    that endpoint it produced prose or spaces on every attempt.
 *
 * What does hold is the schema on the final user turn alone, with no `response_format`: valid JSON
 * on every attempt measured, and the last turn is the one line every OpenAI-compatible service is
 * guaranteed to read last. `jsonMode` is the last resort for a model that rejects the field
 * outright, and takes the same shape.
 */
const requestFor = (config, { system, messages, schema, temperature, maxOutputTokens, model, jsonMode }) => {
  const provider = providerOf(config);
  if (usesOpenAiShape(provider)) {
    // One switch, because the plugin's answer must be JSON either way: the field where it is known
    // to work, the prompt where it is not.
    const structured = !jsonMode && provider === 'openai';
    const turns = turnsFor(messages, provider);
    if (!structured) {
      // A conversation whose last turn is not the visitor's gets one more turn rather than an
      // instruction nobody reads.
      const instruction = jsonInstruction(schema);
      const last = turns.length - 1;
      if (last >= 0 && turns[last].role === 'user') {
        turns[last] = { ...turns[last], content: `${turns[last].content}${instruction}` };
      } else {
        turns.push({ role: 'user', content: instruction.trim() });
      }
    }
    const body = { model, messages: [{ role: 'system', content: system }, ...turns] };
    // The o-series reasoning models reject `temperature`; every other model takes it.
    if (!/^o\d/i.test(model)) body.temperature = temperature;
    if (structured) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', strict: false, schema: caseSchemaTypes(schema, false) },
      };
    }
    return {
      url: provider === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : endpointFor(config.base_url, '/chat/completions'),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
      body,
    };
  }

  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.api_key,
        // Anthropic refuses a request without this; it names the version of the body shape below.
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        // Required by Anthropic, unlike the other two, which have provider-side defaults.
        max_tokens: maxOutputTokens || 4096,
        system: `${system}${jsonInstruction(schema)}`,
        messages: turnsFor(messages, provider),
        // Anthropic's range is 0–1, where OpenAI and Gemini accept 0–2.
        temperature: Math.min(1, Math.max(0, Number(temperature) || 0)),
      },
    };
  }

  const generationConfig = {
    temperature,
    responseMimeType: 'application/json',
    responseSchema: caseSchemaTypes(schema, true),
  };
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.api_key },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: turnsFor(messages, provider),
      generationConfig,
    },
  };
};

// -- Turning a failure into a sentence -------------------------------------------------------------
//
// A saved key that is wrong, a model this account cannot use, a quota that ran out: each is a
// sentence naming Settings → Integrations → AI, because that is the screen that fixes it.

/** The first readable sentence in whatever a provider returned, so a failure is quoted, not invented. */
const providerMessage = (payload, status) => {
  const candidates = [
    payload?.error?.message, payload?.error, payload?.message, payload?.errors?.[0]?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return `HTTP ${status}`;
};

/** The answer text out of any provider's success payload. */
const answerText = (payload, provider) => {
  if (provider === 'anthropic') {
    const blocks = payload?.content;
    return Array.isArray(blocks) ? blocks.map((block) => String(block?.text || '')).join('') : '';
  }
  if (usesOpenAiShape(provider)) return String(payload?.choices?.[0]?.message?.content || '');
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part) => part?.text || '').join('') : '';
};

/**
 * A retired Gemini model's replacement, read out of the error that named it.
 *
 * Google's message ends with a sentence such as `Please use models/gemini-2.5-flash for the latest
 * version.`, which is the only place the new name is stated.
 */
const replacementModel = (message, current) => {
  const match = String(message).match(/use\s+models\/(gemini-[\w.-]+)/i);
  const name = match ? match[1].replace(/[.-]+$/, '') : '';
  return name && name !== current ? name : '';
};

/** A provider's HTTP failure as one of our errors, with a sentence an administrator can act on. */
const failureFrom = (result, { config, model }) => {
  const name = aiProviderName(config);
  const message = providerMessage(result.payload, result.status);

  if (result.status === 429) {
    return new AiError(429, `${name}'s rate limit or quota was reached (${message}). Wait a minute and try again.`);
  }
  if (result.status === 401 || result.status === 403 || /api[_ -]?key|unauthorized|invalid.*credential/i.test(message)) {
    return new AiError(502, `${name} rejected the saved key: ${message} Check the key on ${AI_SETTINGS_HINT}.`);
  }
  if (result.status === 404) {
    return new AiError(502, `The ${name} model "${model}" is not available: ${message} Choose a different model on ${AI_SETTINGS_HINT}.`);
  }
  return new AiError(502, `${name} returned an error: ${message}`);
};


// -- The one call a plugin makes -------------------------------------------------------------------

/**
 * Runs one generation and returns the answer parsed as JSON.
 *
 * @param {object} config the `ai_config` row, from `readAiConfig` / `ctx.aiConfig()`
 * @param {object} request
 * @param {string} request.system  the system prompt: the rules, the voice, what may be answered
 * @param {Array<{role: 'user'|'assistant', text: string}>} request.messages the conversation
 * @param {object} request.schema  the JSON schema the answer must match, Gemini-cased
 * @param {number} [request.temperature]     default 0.4
 * @param {number} [request.maxOutputTokens] a ceiling on the answer, when the plugin needs one
 * @param {number} [request.timeoutMs]       default 60000, so a hung provider fails with a sentence
 * @param {string} [request.model]           overrides the row's model (not used by the plugins today)
 * @param {string} [request.blocked]         what to say when the provider refuses on policy grounds
 * @param {string} [request.truncated]       what to say when the answer was cut off by the token limit
 * @param {string} [request.logTag]          the plugin's tag, so the one warning below is traceable
 * @returns {Promise<{parsed: unknown, model: string}>}
 * @throws {AiError} for every failure, carrying the status the route should answer with
 */
export async function callAiJson(config, request = {}) {
  const provider = providerOf(config);
  const name = aiProviderName(config);
  const {
    system = '', messages = [], schema = {}, temperature = 0.4, maxOutputTokens = 0,
    timeoutMs = 60000, model: override = '', blocked = '', truncated = '', logTag = 'rwp',
  } = request;

  if (!isAiConfigured(config)) {
    throw new AiError(501, `The AI key is not set up yet. Save one on ${AI_SETTINGS_HINT} — Gemini, OpenAI, Anthropic or any OpenAI-compatible provider — then try again.`);
  }
  const model = String(override || aiModelFor(config)).trim();
  /** Whether this provider's first attempt goes out with `response_format` (see `requestFor`). */
  const structured = usesOpenAiShape(provider) && provider === 'openai';

  /** One request, with a timeout. Every retry below is explicit, so no failure loops. */
  const send = async (modelName, jsonMode = false) => {
    const { url, headers, body } = requestFor(config, {
      system, messages, schema, temperature, maxOutputTokens, model: modelName, jsonMode,
    });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller?.signal });
      const text = await response.text().catch(() => '');
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        // A proxy in front of a provider can answer HTML; `text` is then the best explanation there is.
      }
      return { ok: response.ok, status: response.status, payload, text };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        payload: null,
        text: controller?.signal.aborted
          ? `did not answer within ${Math.round(timeoutMs / 1000)} seconds`
          : (error instanceof Error ? error.message : 'unknown network error'),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const result = await send(model);

  if (result.ok) {
    // A 200 whose message is empty is not an answer — the plugin can only report "answered with
    // nothing". When the request asked for structured output and got nothing back, ask once more
    // without it: that changes the request, where simply repeating it would not.
    if (structured && !answerText(result.payload, provider).trim()) {
      console.warn(`[${logTag}] ${name} answered a structured-output request with an empty message; asking again with the schema in the prompt.`);
      const retried = await send(model, true);
      if (retried.ok) return finish(retried, provider, model, blocked, truncated, name, logTag);
      throw retried.status === 0
        ? new AiError(504, `Could not reach the ${name} API from the server: ${retried.text}. Try again in a moment.`)
        : failureFrom(retried, { config, model });
    }
    return finish(result, provider, model, blocked, truncated, name, logTag);
  }

  // Unreachable is not the same as rejected: say which one happened.
  if (result.status === 0) {
    throw new AiError(504, `Could not reach the ${name} API from the server: ${result.text}. Try again in a moment.`);
  }

  const message = providerMessage(result.payload, result.status);

  // A retired Gemini model's error names its replacement: switch once, and remember it for this process.
  const replacement = provider === 'gemini' && [400, 403, 404].includes(result.status)
    && /no longer available|not found|deprecated|retired|update your code/i.test(message)
    ? replacementModel(message, model) : '';
  if (replacement) {
    console.warn(`[${logTag}] ${name} model "${model}" is unavailable; switching to "${replacement}" as the error suggests. Save it on ${AI_SETTINGS_HINT} to make that permanent.`);
    const retried = await send(replacement);
    if (retried.ok) {
      suggestedModels[provider] = replacement;
      return finish(retried, provider, replacement, blocked, truncated, name, logTag);
    }
  }

  // Structured outputs are newer than some models: ask for JSON in the prompt instead of failing.
  // Only worth a retry when the first attempt actually sent the field — for a compatible service it
  // never does, so the retry would be the same request again.
  if (structured && (result.status === 400 || result.status === 422) && /response_format|json_schema|structured/i.test(message)) {
    const retried = await send(model, true);
    if (retried.ok) return finish(retried, provider, model, blocked, truncated, name, logTag);
  }

  throw failureFrom(result, { config, model });
}


/**
 * The first complete JSON object inside a longer answer.
 *
 * Even a model told to answer with "a single JSON object only" sometimes introduces it — "Here is
 * the reply: {...}" — or appends a sentence after it. Quotes and escapes are tracked so a brace
 * inside a string does not end the object early. The result is only ever handed to `JSON.parse`,
 * so a wrong guess costs nothing.
 */
const firstJsonObject = (text) => {
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return '';
};

/**
 * The success payload as `{ parsed, model }`, or the refusal or truncation as an error.
 *
 * Split out because three paths reach it — the first try, a replaced model, a JSON-mode retry — and
 * the question "did the provider answer, refuse, or run out of room?" is the same for all three.
 */
function finish(result, provider, model, blocked, truncated, name, logTag) {
  if (provider === 'gemini' && result.payload?.promptFeedback?.blockReason) {
    throw new AiError(422, blocked || `Gemini blocked this request (${result.payload.promptFeedback.blockReason}). Rephrase it and try again.`);
  }

  const candidate = usesOpenAiShape(provider)
    ? result.payload?.choices?.[0]
    : provider === 'anthropic' ? result.payload : result.payload?.candidates?.[0];
  const reason = String(candidate?.finish_reason || candidate?.finishReason || candidate?.stop_reason || '').toUpperCase();
  if (['SAFETY', 'PROHIBITED_CONTENT', 'CONTENT_FILTER', 'BLOCKLIST', 'REFUSAL'].includes(reason)) {
    throw new AiError(422, blocked || `${name} refused to answer this request (${reason}). Rephrase it and try again.`);
  }

  const text = answerText(result.payload, provider).trim();
  if (!text) {
    if (reason === 'MAX_TOKENS' || reason === 'LENGTH') {
      throw new AiError(422, truncated || 'The answer was cut off before it was finished. Ask for something smaller.');
    }
    // "Answered with nothing" on its own names neither the finish reason nor whether the provider
    // said anything at all. Both go to the server log now, so the next occurrence is diagnosable
    // without a reproduction.
    console.warn(`[${logTag}] ${name} answered with an empty message (finish reason "${reason || 'none'}").`);
    throw new AiError(502, `${name} answered with nothing. Try again, or ask for something smaller.`);
  }

  // A fenced code block is a JSON answer wearing a costume; every provider family does it occasionally.
  // After that, an answer with prose around the object — which is what a service asked in the prompt
  // still produces now and then — is recovered rather than thrown away.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  for (const shape of [cleaned, firstJsonObject(cleaned)]) {
    if (!shape) continue;
    try {
      return { parsed: JSON.parse(shape), model };
    } catch {
      // The next shape, then the error below.
    }
  }

  // Without the answer's own words the only report is "did not answer with usable JSON", which names
  // neither the provider's habit nor the request that provoked it. This is the model's output, never a
  // credential, and quoting the start of it in the server log is usually the whole diagnosis.
  console.warn(`[${logTag}] ${name} answered without parseable JSON; the answer began: ${JSON.stringify(text.slice(0, 300))}`);
  throw new AiError(502, `${name} did not answer with usable JSON. Try again, or ask for something smaller.`);
}


