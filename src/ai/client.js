/**
 * Universal chat client.
 *
 * One `chat()` entry point for four API families (openai / google / anthropic /
 * ollama), with streaming, retries, timeouts and friendly error mapping.
 * Runs in the service worker only (needs host permissions).
 */

import { resolveChatUrl, resolveModelsUrl, expandBaseUrl } from './providers.js';
import { sleep } from '../common/util.js';

export class AIError extends Error {
  constructor(code, message, { hint = '', status = 0, detail = '', provider = '', retryable = false } = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.detail = detail;
    this.provider = provider;
    this.retryable = retryable;
  }
}

export function isAIError(err) {
  return err instanceof AIError || (err && typeof err.code === 'string');
}

/** Finish reasons that mean "stopped because the output budget ran out". */
const TRUNCATION_FINISH = new Set(['length', 'max_tokens', 'max_output_tokens', 'maxtokens']);

/* ------------------------------------------------------------------ requests */

/**
 * Gemini 2.5 counts its thinking tokens against maxOutputTokens. With a
 * summary-sized budget the model spent the whole allowance thinking and the
 * response arrived as finishReason MAX_TOKENS with no JSON at all — two
 * attempts in a row ended in “TRUNCATED”. Writing a конспект does not need
 * extended thinking, so Flash gets zero thinking and Pro, which cannot switch
 * it off, gets the smallest budget it accepts.
 */
function googleThinkingConfig(model) {
  const id = String(model || '').toLowerCase();
  if (!/gemini-2\.5/.test(id)) return null;
  return { thinkingBudget: /pro/.test(id) ? 128 : 0 };
}

/**
 * OpenRouter routes “:free” models to whatever is available, often a reasoning
 * variant that spends the whole answer budget thinking and returns
 * finish_reason=length with no JSON. A summary needs the text, not a long
 * train of thought: low effort keeps the answer fast and inside the budget.
 * Only OpenRouter understands this field, so no other endpoint receives it.
 */
function openRouterReasoning(provider, model) {
  if (!String(provider?.baseUrl || '').includes('openrouter.ai')) return null;
  const id = String(model || '').toLowerCase();
  if (!/(:free$|\/free$|thinking|reasoning|gpt-oss|deepseek-r1|qwen3|glm-4\.5|kimi-k2)/.test(id)) return null;
  return { effort: 'low' };
}

function authHeaders(provider, apiKey) {
  const headers = { ...(provider.headers || {}) };
  const scheme = provider.authScheme || 'bearer';
  const key = String(apiKey || '').trim();
  if (!key || scheme === 'none') return headers;
  switch (scheme) {
    case 'bearer':
      headers.Authorization = `Bearer ${key}`;
      break;
    case 'x-api-key':
      headers['x-api-key'] = key;
      break;
    case 'header':
      headers[provider.authHeader || 'Authorization'] = key;
      break;
    default:
      break;
  }
  return headers;
}

function withQueryKey(url, provider, apiKey) {
  if ((provider.authScheme || 'bearer') !== 'query' || !apiKey) return url;
  const u = new URL(url);
  u.searchParams.set(provider.authQueryParam || 'key', String(apiKey).trim());
  return u.toString();
}

export function buildRequest({ provider, apiKey, model, messages, temperature, maxTokens, stream, jsonMode, signal }) {
  const base = { headers: {}, body: {}, mode: 'openai-json', url: '' };
  const systemMessages = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const dialog = messages.filter((m) => m.role !== 'system');

  if (provider.type === 'google') {
    const isStream = !!stream;
    const thinking = googleThinkingConfig(model);
    const base = resolveChatUrl(provider, model);
    const withStream = isStream ? base.replace(':generateContent', ':streamGenerateContent') : base;
    const url = withQueryKey(`${withStream}${isStream ? (withStream.includes('?') ? '&' : '?') + 'alt=sse' : ''}`, provider, apiKey);
    const body = {
      contents: dialog.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };
    if (systemMessages) body.systemInstruction = { parts: [{ text: systemMessages }] };
    return {
      ...base,
      url,
      mode: isStream ? 'google-sse' : 'google-json',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
      body,
    };
  }

  if (provider.type === 'anthropic') {
    const isStream = !!stream;
    const url = resolveChatUrl(provider, model);
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: dialog.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ...(isStream ? { stream: true } : {}),
    };
    if (systemMessages) body.system = systemMessages;
    return {
      ...base,
      url,
      mode: isStream ? 'anthropic-sse' : 'anthropic-json',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...authHeaders(provider, apiKey),
      },
      body,
    };
  }

  if (provider.type === 'ollama') {
    const isStream = !!stream;
    const url = resolveChatUrl(provider, model);
    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role === 'system' ? 'system' : m.role, content: m.content })),
      stream: isStream,
      ...(jsonMode ? { format: 'json' } : {}),
      options: { temperature, num_predict: maxTokens },
    };
    return {
      ...base,
      url,
      mode: isStream ? 'ollama-ndjson' : 'ollama-json',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
      body,
    };
  }

  // OpenAI-compatible
  const isStream = !!stream;
  const url = resolveChatUrl(provider, model);
  const reasoning = openRouterReasoning(provider, model);
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    max_tokens: maxTokens,
    ...(isStream ? { stream: true } : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
  return {
    ...base,
    url,
    mode: isStream ? 'openai-sse' : 'openai-json',
    headers: { 'content-type': 'application/json', accept: isStream ? 'text/event-stream' : 'application/json', ...authHeaders(provider, apiKey) },
    body,
  };
}

/* ------------------------------------------------------------------ parsing */

function pickOpenAIText(json, { stream = false } = {}) {
  if (!json) return '';
  if (stream) {
    const choice = json.choices?.[0];
    return choice?.delta?.content || choice?.text || '';
  }
  const msg = json.choices?.[0]?.message || {};
  // OpenRouter reports a thinking model's trace as `reasoning` (some providers
  // use `reasoning_content`). Treating it as “no answer at all” made a free
  // router that answered only with its reasoning look broken.
  return msg.content || msg.reasoning_content || msg.reasoning || json.choices?.[0]?.text || '';
}

function pickGoogleText(json, { stream = false } = {}) {
  const candidate = json?.candidates?.[0];
  if (!candidate) return '';
  const parts = candidate.content?.parts || [];
  const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  if (text) return text;
  return stream ? '' : '';
}

function pickAnthropicText(json, { stream = false } = {}) {
  if (stream) return '';
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function pickOllamaText(json, { stream = false } = {}) {
  if (stream) return json?.message?.content || '';
  return json?.message?.content || json?.response || '';
}

function usageFrom(mode, json) {
  const u = json?.usage || json?.usageMetadata || {};
  return {
    promptTokens: Number(u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens ?? json?.prompt_eval_count ?? 0) || 0,
    completionTokens: Number(u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens ?? json?.eval_count ?? 0) || 0,
  };
}

/** Incremental stream reader: handles SSE and NDJSON. */
async function readStream(res, mode, { onDelta, signal, startedAt = Date.now(), touchTransport = null, touchProgress = null }) {
  const reader = res.body?.getReader();
  if (!reader) throw new AIError('NO_STREAM', 'Ответ провайдера не содержит потока', { provider: mode });
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  // Time to the first visible token is the number that explains “the model is
  // slow”: queueing and prompt processing happen before any text arrives, and
  // the total duration alone hides which part of the run it was.
  let ttftMs = 0;
  let usedModel = '';
  let generationId = '';
  let upstreamProvider = '';
  // Reasoning deltas are kept apart: they are shown to the user only when the
  // model never produced a visible answer.
  let reasoning = '';
  let finish = '';
  let usage = { promptTokens: 0, completionTokens: 0 };
  const ndjson = mode === 'ollama-ndjson';
  const separator = ndjson ? '\n' : '\n\n';
  // An explicit end marker ([DONE], Ollama's `done`, Anthropic's `message_stop`)
  // means the answer is over. Some gateways keep the HTTP connection open after
  // it (reverse proxies reuse it), so waiting for EOF would turn a finished
  // answer into a timeout and throw it away. The reader is released instead.
  let ended = false;

  // A fetch-abort usually destroys the response body on its own, but custom
  // readers (and indifferent proxies) can leave `reader.read()` pending
  // forever. Racing every read against the signal makes an abort conclusive
  // instead of best-effort, so the watchdog above cannot be outrun.
  let onAbortSignal = null;
  const abortWait = signal
    ? new Promise((resolve) => {
        onAbortSignal = () => resolve(signal.reason?.message || 'abort');
        if (signal.aborted) onAbortSignal();
        else signal.addEventListener('abort', onAbortSignal, { once: true });
      })
    : null;

  const handlePayload = (payload) => {
    if (!payload) return;
    if (payload === '[DONE]') {
      ended = true;
      return;
    }
    let json = null;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    // Only content-bearing events may reset the progress watchdog: deltas,
    // reasoning deltas and finish markers prove the generation moves, while
    // keepalive comments never even reach this function (an SSE comment is not
    // a `data:` line) — that is the transport clock's business, not progress.
    let progressed = false;
    if (!usedModel && typeof json.model === 'string') usedModel = json.model;
    if (!generationId && typeof json.id === 'string') generationId = json.id;
    if (!upstreamProvider && typeof json.provider === 'string') upstreamProvider = json.provider;
    if (json.usage || json.usageMetadata || json.prompt_eval_count) usage = usageFrom(mode, json);
    if (json.error) {
      const apiMessage = String(json.error.message || json.error.code || '');
      if (looksLikeSafetyRefusal(apiMessage)) {
        throw safetyError({ name: upstreamProvider || '' }, apiMessage);
      }
      throw new AIError('PROVIDER_ERROR', json.error.message || 'Провайдер вернул ошибку', {
        detail: JSON.stringify(json.error).slice(0, 400),
      });
    }
    const choiceFinish = json.choices?.[0]?.finish_reason;
    if (choiceFinish) {
      finish = choiceFinish;
      progressed = true;
      // Some OpenAI-compatible gateways report a mid-stream failure this way
      // instead of an `error` object; the HTTP status is already 200 by then.
      if (choiceFinish === 'error') {
        throw new AIError('PROVIDER_ERROR', 'Провайдер оборвал поток с ошибкой', {
          hint: 'Ответ не получен. Повторите запуск или выберите другую модель.',
          detail: JSON.stringify(json.choices?.[0]?.delta || {}).slice(0, 200),
        });
      }
    }
    let chunk = '';
    if (mode.startsWith('openai')) {
      chunk = pickOpenAIText(json, { stream: true });
      const delta = json.choices?.[0]?.delta;
      const trace = delta?.reasoning || delta?.reasoning_content;
      if (!chunk && typeof trace === 'string' && trace) {
        reasoning += trace;
        progressed = true;
      }
    }    else if (mode.startsWith('google')) {
      chunk = pickGoogleText(json, { stream: true });
      const googleFinish = json?.candidates?.[0]?.finishReason;
      if (googleFinish) {
        // MAX_TOKENS must reach the pipeline as a truncated answer, exactly as
        // it does for the non-streamed Google response.
        finish = googleFinish;
        progressed = true;
      }
    }
    else if (mode.startsWith('anthropic')) {
      const type = json.type;
      if (type === 'content_block_delta') chunk = json.delta?.text || '';
      else if (type === 'message_stop') ended = true;
      else if (type === 'message_delta') {
        if (json.usage) usage = usageFrom(mode, { usage: { output_tokens: json.usage.output_tokens } });
        if (json.delta?.stop_reason) finish = json.delta.stop_reason;
        progressed = true; // stop_reason/usage: the stream is finalizing
      } else if (type === 'error') {
        throw new AIError('PROVIDER_ERROR', json.error?.message || 'Ошибка потока', { detail: JSON.stringify(json).slice(0, 300) });
      }
    } else if (mode.startsWith('ollama')) {
      chunk = pickOllamaText(json, { stream: true });
      if (json?.done === true) {
        if (json.done_reason) finish = json.done_reason;
        progressed = true;
        ended = true;
      }
    }
    if (chunk) {
      if (!text) ttftMs = Date.now() - startedAt;
      text += chunk;
      if (onDelta) onDelta(chunk, text);
      progressed = true;
    }
    if (progressed && touchProgress) touchProgress();
  };

  try {
    for (;;) {
      // Abort check first: the watchdog may have fired between reads.
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error(String(signal.reason?.message || signal.reason || 'abort'));
      }
      const step = abortWait
        ? await Promise.race([reader.read(), abortWait.then((reason) => ({ aborted: reason }))])
        : await reader.read();
      if (step && step.aborted) {
        await reader.cancel().catch(() => {});
        // Preserve the watchdog message (transport-stalled / progress-stalled /
        // generation-not-started) so the error mapping can tell each kind of
        // hang apart from a plain deadline.
        throw new Error(String(step.aborted || 'abort'));
      }
      const { done, value } = step;
      if (done) break;
      // Any incoming byte — a delta, a keepalive comment, an event separator —
      // proves the upstream connection is alive and pushes the transport
      // deadline forward. It says nothing about generation progress.
      if (touchTransport) touchTransport();
      buffer += decoder.decode(value, { stream: true });
      // SSE permits CRLF line endings, and `\r\n\r\n` contains no `\n\n`: an
      // unnormalized buffer would never split, so every delta would arrive at
      // EOF as one concatenated payload that is not valid JSON. A trailing `\r`
      // stays pending and is completed by the next read.
      if (!ndjson && buffer.includes('\r\n')) buffer = buffer.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buffer.indexOf(separator)) !== -1) {
        const rawBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + separator.length);
        const payload = ndjson ? rawBlock.trim() : rawBlock.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (payload) handlePayload(payload);
      }
      if (ended) {
        // The answer is over even if the gateway keeps the connection open;
        // waiting for EOF here used to turn a finished answer into a timeout.
        await reader.cancel().catch(() => {});
        break;
      }
      // The watchdog may have fired while a chunk was being parsed. Throwing
      // (not breaking) matters: a half-parsed answer must not escape as a
      // successful “summary”.
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error(String(signal.reason?.message || signal.reason || 'abort'));
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = ndjson ? buffer.trim() : buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (payload && payload !== '[DONE]') handlePayload(payload);
    }
  } catch (err) {
    // A provider error inside the stream must not leave the body unread: the
    // connection is released before the error reaches the caller.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    // The stream finished (or failed): no future abort can arrive that matters,
    // so drop the race listener instead of leaving it attached forever.
    if (signal && onAbortSignal) signal.removeEventListener('abort', onAbortSignal);
  }
  return { text, usage, reasoning, finish, ttftMs, model: usedModel, generationId, upstreamProvider };
}

function finalText(mode, json) {
  if (mode === 'openai-json') return pickOpenAIText(json);
  if (mode === 'google-json') return pickGoogleText(json);
  if (mode === 'anthropic-json') return pickAnthropicText(json);
  if (mode === 'ollama-json') return pickOllamaText(json);
  return '';
}

/* -------------------------------------------------------------- error mapping */

/**
 * OpenRouter's moderation verdict, as it arrives from the API: the refusal is
 * often written as plain text (“User Safety: unsafe / Response Safety: unsafe /
 * Safety Categories: …”), not as JSON. Treating that text as a malformed answer
 * produced BAD_JSON and sent the same blocked content through the JSON repair
 * prompt, which could never succeed.
 */
const SAFETY_PATTERNS = [
  /\buser safety\b/i,
  /\bresponse safety\b/i,
  /\bsafety\s+categor/i,
  /\bcontent[_ ]?policy\b/i,
  /\b(content[_ ]?filter|moderation)\b/i,
  /\b(flagged|blocked)\b.{0,24}\b(safety|moderation|policy)\b/i,
];

/**
 * True when an answer is a provider safety refusal rather than content. Only
 * short answers are inspected: a transcript fragment may legitimately discuss
 * moderation, and a flag on a long text would turn a real answer into an error.
 */
export function looksLikeSafetyRefusal(text, { finish = '' } = {}) {
  if (String(finish || '').toLowerCase() === 'content_filter') return true;
  const value = String(text || '').trim();
  if (!value || value.length > 600) return false;
  // A JSON answer is content, even when the video discusses moderation: the
  // verdict always arrives as prose (“User Safety: unsafe …”).
  if (/^[{[]/.test(value)) return false;
  // OpenRouter's own safety classifier answers “User Safety: safe” when it is
  // routed as the model. That is a useless model, not a refusal.
  if (/\bsafety\s*:\s*safe\b/i.test(value) && !/\bunsafe\b/i.test(value)) return false;
  return SAFETY_PATTERNS.some((re) => re.test(value));
}

/**
 * The exact shape a *content-safety classifier model* answers with. OpenRouter's
 * free router can dispatch a request to such a model (Nemotron Guard and
 * friends): it replies “User Safety: unsafe / Response Safety: unsafe /
 * Safety Categories: …” to every prompt, including a harmless transcript. That
 * is not a refusal of this request — the request never reached a writing model.
 *
 * Live runs also meet the single-line verdict (“User Safety: safe”, which is the
 * classifier approving itself). It used to fall through as ordinary content and
 * ended as BAD_JSON — “the model answered with text, not JSON” — which sent the
 * user to a JSON-repair retry that could never succeed. A verdict is recognized
 * by where it sits: it opens the answer, it is not part of a summary.
 */
export function looksLikeSafetyVerdict(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 600) return false;
  if (/^[{[]/.test(value)) return false;
  const head = value.split(/\r?\n/)[0].trim();
  if (/^(user|response)\s+safety\s*:/i.test(head)) return true;
  if (/^safety\s+categories?\s*:/i.test(head)) return true;
  return /\buser safety\s*:/i.test(value) && /\b(response safety|safety\s+categor)/i.test(value);
}

/** A router that picked the wrong kind of model: retry, don't blame the user. */
export function misroutedModelError(provider, detail = '', servedModel = '') {
  return new AIError('MISROUTED_MODEL', 'Вместо конспекта модель вернула вердикт проверки безопасности', {
    hint: 'Похоже, роутер выбрал модель-классификатор, а не модель для текста. Расширение повторит запрос и попадёт на рабочую модель; если это повторяется, выберите конкретную модель вместо openrouter/free.',
    detail: `${servedModel ? `${servedModel}: ` : ''}${String(detail || '').slice(0, 300)}`,
    provider: provider?.name || '',
    retryable: true,
  });
}

/** The one refusal code: retrying it unchanged only repeats the refusal. */
export function safetyError(provider, detail = '') {
  return new AIError('SAFETY', 'Провайдер заблокировал запрос фильтром безопасности', {
    hint: 'Повтор того же запроса даст тот же отказ. Выберите другую модель или провайдера, либо короткий формат конспекта.',
    detail: String(detail || '').slice(0, 600),
    provider: provider?.name || '',
  });
}

export function mapHttpError(status, bodyText, provider) {
  const name = provider?.name || 'провайдер';
  const detail = String(bodyText || '').slice(0, 600);
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* not json */
  }
  const apiMessage =
    parsed?.error?.message || parsed?.error?.msg || parsed?.message || parsed?.detail || parsed?.errors?.[0]?.message || '';
  const haystack = `${detail} ${apiMessage}`.toLowerCase();

  // Moderation on OpenRouter comes back as 403/400 with the safety verdict in
  // the body; the key itself is fine, so it must not read as AUTH.
  if ((status === 400 || status === 403) && looksLikeSafetyRefusal(apiMessage || detail)) {
    const err = safetyError(provider, apiMessage || detail);
    err.status = status;
    return err;
  }
  if (status === 401 || status === 403) {
    return new AIError('AUTH', `Ключ отклонён (${status}) — проверьте API-ключ в настройках`, {
      hint: `Провайдер ${name} не принял ключ. Возможно, ключ скопирован не полностью, отозван или у него нет доступа к выбранной модели.`,
      status,
      detail,
      provider: name,
    });
  }
  if (status === 404) {
    return new AIError('MODEL_NOT_FOUND', `Endpoint или модель не найдены (404)`, {
      hint: `Проверьте базовый URL и имя модели для ${name}. Список моделей можно загрузить кнопкой «Обновить список».`,
      status,
      detail,
      provider: name,
    });
  }
  if (status === 402) {
    return new AIError('BILLING', 'Провайдер требует оплату или превышен лимит бесплатного тарифа (402)', {
      hint: `Пополните баланс в ${name} или выберите бесплатную модель (например, с суффиксом :free у OpenRouter).`,
      status,
      detail,
      provider: name,
    });
  }
  if (status === 429) {
    return new AIError('RATE_LIMIT', 'Слишком много запросов (429) — провайдер ограничил частоту', {
      hint: `Подождите минуту, уменьшите «Параллельные запросы» в настройках или подключите второго провайдера как резерв.`,
      status,
      detail,
      provider: name,
      retryable: true,
    });
  }
  if (status === 400 && haystack.includes('response_format')) {
    return new AIError('RESPONSE_FORMAT', 'Провайдер не поддерживает строгий JSON-режим', {
      hint: 'OpenSummary повторит запрос без JSON-режима автоматически.',
      status,
      detail,
      provider: name,
    });
  }
  if (haystack.includes('context length') || haystack.includes('too long') || haystack.includes('maximum context') || haystack.includes('token limit')) {
    return new AIError('CONTEXT_LENGTH', 'Транскрипт не поместился в контекст модели', {
      hint: 'Уменьшите «Размер чанка» в настройках — OpenSummary разобьёт видео на большее число частей.',
      status,
      detail,
      provider: name,
    });
  }
  if (status >= 500) {
    return new AIError('SERVER', `Провайдер ответил ошибкой ${status}`, {
      hint: 'Это временная проблема на стороне сервиса — повторите попытку.',
      status,
      detail,
      provider: name,
      retryable: true,
    });
  }
  return new AIError('HTTP', `Ошибка ${status} от ${name}`, {
    hint: apiMessage || 'Проверьте настройки провайдера.',
    status,
    detail,
    provider: name,
  });
}

/**
 * The provider accepted the request and answered with nothing. Free and
 * “reasoning” models do this often; the panel turns such a run into a local
 * summary rather than a multi-minute wait with no result.
 */
function emptyAnswerError(provider, { finish = '', usage = {} } = {}) {
  const spent = Number(usage?.completionTokens) || 0;
  const bits = [];
  if (finish) bits.push(`finish: ${finish}`);
  if (spent) bits.push(`токенов ответа: ${spent}`);
  return new AIError('EMPTY_RESPONSE', 'Модель вернула пустой ответ', {
    hint:
      'Так ведут себя бесплатные и «думающие» модели: ответ уходит на рассуждения, и в текст не попадает ничего. Выберите модель без режима размышлений, уменьшите объём конспекта или сделайте конспект локальным движком.',
    provider: provider?.name || '',
    detail: bits.join(' · '),
  });
}

function mapNetworkError(err, provider) {
  const name = provider?.name || 'провайдер';
  const message = String(err?.message || err || '');
  const local = provider?.local || /localhost|127\.0\.0\.1/.test(provider?.baseUrl || '');
  if (/transport-stalled/i.test(message)) {
    return new AIError('TIMEOUT', `Провайдер перестал посылать поток ответа (${name})`, {
      hint:
        'Соединение было живо, затем данные оборвались полностью. Повторная попытка обычно попадает на рабочую модель; если это повторяется часто, выберите провайдера с более стабильными моделями.',
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (/progress-stalled/i.test(message)) {
    return new AIError('TIMEOUT', `Поток жив, но генерация не продвигается (${name})`, {
      hint:
        'Соединение отвечало (приходили служебные keepalive-события), но модель перестала выдавать результат. Повторная попытка обычно попадает на рабочую модель.',
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (/job-deadline/i.test(message)) {
    return new AIError('TIMEOUT', `Общий бюджет задания исчерпан (${name})`, {
      hint: 'Задание остановлено по общему лимиту времени, а не из-за зависания потока. Готовые фрагменты сохранены — повторный запуск продолжит с них.',
      detail: 'job-deadline',
      provider: name,
    });
  }
  if (/generation-not-started/i.test(message)) {
    return new AIError('TIMEOUT', `Модель не начала генерацию (${name})`, {
      hint:
        'Соединение отвечало служебными событиями, но содержательные события так и не пошли. Повторная попытка обычно попадает на рабочую модель; часто это значит, что модель недоступна.',
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (/stream-stalled/i.test(message)) {
    // Legacy internal reason, kept so older diagnostics stay readable.
    return new AIError('TIMEOUT', `Провайдер перестал посылать поток ответа (${name})`, {
      hint:
        'Запрос был принят, но модель перестала присылать данные. Повторная попытка обычно попадает на рабочую модель; если это повторяется часто, выберите провайдера с более стабильными моделями.',
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (/^timeout$/i.test(message) || /timed?\s*out/i.test(message)) {
    return new AIError('TIMEOUT', 'Превышено время ожидания ответа', {
      hint: `Увеличьте таймаут в настройках или проверьте доступность ${name}.`,
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (/abort/i.test(message)) {
    return new AIError('TIMEOUT', 'Превышено время ожидания ответа', {
      hint: `Увеличьте таймаут в настройках или проверьте доступность ${name}.`,
      detail: message,
      provider: name,
      retryable: true,
    });
  }
  if (local) {
    return new AIError('LOCAL_OFFLINE', `${name} недоступен`, {
      hint: 'Запустите локальный сервер (например, `ollama serve`) и разрешите доступ к localhost. Проверьте порт в настройках провайдера.',
      detail: message,
      provider: name,
    });
  }
  return new AIError('NETWORK', `Не удалось подключиться к ${name}`, {
    hint: 'Проверьте интернет, правильность базового URL и доступ расширения к этому хосту (Настройки → «Доступ к хосту»).',
    detail: message,
    provider: name,
  });
}

/* -------------------------------------------------------------------- public */

/**
 * Stream silence windows. Apply only to streaming requests: SSE/NDJSON are
 * expected to emit bytes continuously, so dead silence means the run is stuck.
 * Non-streaming requests wait for the full response and keep only the total
 * timeout.
 *
 * Transport and progress are deliberately different clocks:
 *   • STREAM_STALL_MS (`transport-stalled`) — any bytes (a delta, a keepalive
 *     comment, an SSE separator) prove the connection is alive; a fully silent
 *     socket is dead transport.
 *   • STREAM_PROGRESS_MS (`progress-stalled`) — only content events (text or
 *     reasoning deltas, finish markers) prove the generation moves. Bare
 *     keepalives never count, so a “polite” hung model cannot hide behind them
 *     once it started answering.
 *   • STREAM_PROGRESS_FIRST_MS (`generation-not-started`) — the generous
 *     first-content budget. Thinking models legitimately stream nothing but
 *     keepalives while generating their trace, so that phase is not treated as
 *     a stall before this window; only after the model starts emitting content
 *     does the tight mid-stream window apply. When the total timeout is below
 *     it (the 90 s default), the deadline fires first and this guard stays
 *     dormant.
 */
export const STREAM_STALL_MS = 45000;
export const STREAM_PROGRESS_MS = 60000;
export const STREAM_PROGRESS_FIRST_MS = 150000;

/** Retry policy of one logical operation (see `operationBudgetMs`). */
export const RETRY_BASE_MS = 700;
export const RETRY_MAX_WAIT_MS = 45000;
export const RETRY_AFTER_MAX_MS = 60000;

/**
 * Exponential retry wait with bounded jitter. Two fragments that hit the same
 * 429 must not retry in lockstep and reproduce the burst that caused it; the
 * jitter adds up to 25% on top of the exponential base and never shortens a
 * provider's Retry-After. Capped by RETRY_MAX_WAIT_MS, never unbounded.
 */
export function retryBackoffMs(attempt, hinted = 0, random = Math.random) {
  const base = Math.max(RETRY_BASE_MS * 2 ** (Math.max(1, Number(attempt) || 1) - 1), Number(hinted) || 0);
  const roll = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.min(RETRY_MAX_WAIT_MS, base + Math.floor(base * 0.25 * roll));
}

/**
 * Overall wall-clock budget of one logical `chat()` operation, retries and
 * waits included. It deliberately covers a full first generation plus one full
 * retry (and one worst-case rate-limit wait): a single live generation never
 * gets a shorter timeout than `timeoutMs`, while further configured retries and
 * the extra 429 attempt must fit into what is left. Without this ceiling three
 * attempts plus two 45 s waits could hold a run for six minutes at the default
 * 90 s timeout.
 *
 * `timeoutMs = 0` means “no per-attempt deadline”, so no derived budget is
 * imposed either; callers can still pass an explicit `totalTimeoutMs`.
 * @returns {number} budget in milliseconds, 0 for unbounded
 */
export function operationBudgetMs(timeoutMs) {
  const perAttempt = Math.max(0, Number(timeoutMs) || 0);
  return perAttempt ? perAttempt * 2 + RETRY_MAX_WAIT_MS : 0;
}

function combineSignals(timeoutMs, external, windows = null) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : null;
  // Resettable watchdogs for streaming answers. A model that accepted the
  // request but stopped sending bytes used to pin the run until the full
  // timeout — a hung free model burned it twice, which is exactly the
  // “six minutes and no result” report. And a hung model that kept sending
  // keepalive comments used to pass for “alive” forever; hence the separate
  // progress clock that only content events may reset.
  const { transportMs = 0, progressMs = 0, progressFirstMs = 0 } = windows || {};
  let transportTimer = null;
  let progressTimer = null;
  let touchTransport = null;
  let touchProgress = null;
  if (transportMs > 0) {
    touchTransport = () => {
      if (transportTimer) clearTimeout(transportTimer);
      transportTimer = setTimeout(() => controller.abort(new Error('transport-stalled')), transportMs);
    };
    touchTransport();
  }
  if (progressFirstMs > 0 || progressMs > 0) {
    const initial = progressFirstMs > 0 ? progressFirstMs : progressMs;
    progressTimer = setTimeout(() => controller.abort(new Error('generation-not-started')), initial);
    touchProgress = () => {
      if (progressTimer) clearTimeout(progressTimer);
      // A zero `progressMs` means “policing only until first content”: after
      // that the caller does not want a mid-stream gap watchdog at all.
      progressTimer = progressMs > 0 ? setTimeout(() => controller.abort(new Error('progress-stalled')), progressMs) : null;
    };
  }
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    // `touchTransport` — anything arrived over the wire (bytes, keepalives).
    // `touchProgress` — a content event arrived (delta, reasoning, finish).
    touchTransport,
    touchProgress,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (transportTimer) clearTimeout(transportTimer);
      if (progressTimer) clearTimeout(progressTimer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Sends one chat completion.
 * @returns {Promise<{text: string, usage: object, latencyMs: number, model: string}>}
 */
export async function chat({
  provider,
  apiKey = '',
  model,
  messages,
  temperature = 0.3,
  maxTokens = 2000,
  stream = false,
  jsonMode = false,
  timeoutMs = 90000,
  // Total budget for this call: every attempt and every wait between them.
  // 0/absent derives it from `timeoutMs` via `operationBudgetMs`.
  totalTimeoutMs = 0,
  // Absolute epoch deadline inherited from a parent operation (a task or a
  // provider fallback chain). It can only shorten this call, never extend it.
  deadlineAt = 0,
  // `detail` reported when the inherited deadline is the binding one; lets the
  // UI tell “the whole job ran out of time” from “this request stalled”.
  deadlineDetail = 'job-deadline',
  retries = 1,
  // Benchmark mode can forbid every automatic second request, including the
  // free-tier 429 retry and the JSON-mode fallback.
  allowRateRetry = true,
  allowFormatRetry = true,
  streamStallMs = STREAM_STALL_MS,
  streamProgressMs = STREAM_PROGRESS_MS,
  streamProgressFirstMs = STREAM_PROGRESS_FIRST_MS,
  signal,
  onDelta,
  onRetry,
}) {
  if (!provider) throw new AIError('NO_PROVIDER', 'Провайдер не выбран', { hint: 'Откройте настройки и добавьте провайдера.' });
  if (!model) throw new AIError('NO_MODEL', 'Не выбрана модель', { hint: 'Укажите модель в настройках провайдера.' });
  const needsKey = (provider.authScheme || 'bearer') !== 'none';
  if (needsKey && !String(apiKey || '').trim() && !provider.local) {
    throw new AIError('NO_KEY', `Не задан API-ключ для ${provider.name}`, {
      hint: `Получите ключ: ${provider.keyUrl || provider.docs || 'в кабинете провайдера'} и вставьте его в настройках OpenSummary.`,
    });
  }

  let attempt = 0;
  let useJsonMode = jsonMode;
  let lastError = null;
  // `retries` counts *retries*, i.e. total attempts = 1 + retries. Non-retryable
  // errors (bad key, unknown model, wrong JSON mode) fail immediately.
  const maxAttempts = Math.max(1, 1 + Number(retries || 0));
  // A rate-limited free tier gets one attempt beyond the configured retries:
  // its quota window (often 30 s per IP) is longer than the whole retry budget,
  // and losing every chunk to 429 is how a free provider “fails” a whole video.
  // A wrong-model route gets the same treatment: a router that answered with a
  // classifier verdict is re-rolled once more, because the next route is almost
  // always a writing model. The attempt is cheap (the verdict arrives at once).
  const attemptLimit = () =>
    maxAttempts +
    (allowRateRetry !== false && lastError?.code === 'RATE_LIMIT' ? 1 : 0) +
    (lastError?.code === 'MISROUTED_MODEL' ? 1 : 0);
  const runStarted = Date.now();
  const perAttemptTimeout = Math.max(0, Number(timeoutMs) || 0);
  const operationBudget = Number(totalTimeoutMs) > 0 ? Number(totalTimeoutMs) : operationBudgetMs(perAttemptTimeout);
  const ownDeadlineAt = operationBudget > 0 ? runStarted + operationBudget : 0;
  const inheritedDeadlineAt = Number(deadlineAt) > 0 ? Number(deadlineAt) : 0;
  // The earlier deadline wins. A parent operation can only shorten a child.
  const activeDeadlines = [ownDeadlineAt, inheritedDeadlineAt].filter((v) => v > 0);
  const effectiveDeadlineAt = activeDeadlines.length ? Math.min(...activeDeadlines) : 0;
  const bindingDetail = inheritedDeadlineAt > 0 && (!ownDeadlineAt || inheritedDeadlineAt <= ownDeadlineAt)
    ? String(deadlineDetail || 'job-deadline')
    : 'operation-deadline';
  const effectiveBudget = effectiveDeadlineAt ? Math.max(0, effectiveDeadlineAt - runStarted) : operationBudget;
  const remainingMs = () => (effectiveDeadlineAt ? effectiveDeadlineAt - Date.now() : Infinity);
  // The operation deadline is final: no further request may start after it,
  // even if the configured retries and the 429 bonus would allow one.
  const operationDeadlineError = (attempts, cause = null) => {
    const remainingAtFail = Math.max(0, Math.round(remainingMs() / 1000));
    const isJob = bindingDetail === 'job-deadline';
    const err = new AIError('TIMEOUT', isJob ? 'Истёк общий лимит времени задания' : 'Истёк общий лимит времени на ответ модели', {
      hint: isJob
        ? `Общий бюджет задания (${Math.round(effectiveBudget / 1000)} с) исчерпан${cause?.code ? `, последняя ошибка: ${cause.code}` : ''}. Уже готовые фрагменты сохранены — повторный запуск продолжит с них; можно также сменить провайдера или уменьшить число повторов.`
        : `Общий лимит (${Math.round(effectiveBudget / 1000)} с с учётом повторов) исчерпан${cause?.code ? `, последняя ошибка: ${cause.code}` : ''}. Повторите позже или выберите другого провайдера.`,
      detail: bindingDetail,
      provider: provider.name,
    });
    err.attempts = attempts;
    err.elapsedMs = Date.now() - runStarted;
    err.budgetMs = effectiveBudget;
    err.remainingMs = remainingAtFail * 1000;
    return err;
  };

  while (attempt < attemptLimit()) {
    const leftBefore = remainingMs();
    if (leftBefore <= 0) throw operationDeadlineError(attempt, lastError);
    attempt++;
    const started = Date.now();
    let headersMs = 0;
    // A live first generation keeps the full per-attempt timeout; only a retry
    // can be shortened, and only because the operation deadline demands it.
    const attemptTimeout = perAttemptTimeout
      ? (effectiveDeadlineAt ? Math.min(perAttemptTimeout, leftBefore) : perAttemptTimeout)
      : (effectiveDeadlineAt ? leftBefore : 0);
    const { signal: combined, cleanup, touchTransport, touchProgress } = combineSignals(
      attemptTimeout,
      signal,
      stream
        ? { transportMs: streamStallMs, progressMs: streamProgressMs, progressFirstMs: streamProgressFirstMs }
        : null,
    );
    try {
      const request = buildRequest({ provider, apiKey, model, messages, temperature, maxTokens, stream, jsonMode: useJsonMode, signal: combined });
      const url = request.mode === 'google-json' || request.mode === 'google-sse'
        ? withQueryKey(request.url, provider, apiKey)
        : request.url;
      const res = await fetch(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: combined,
        credentials: 'omit',
      });
      // Time until the provider accepted the request and sent headers. It is
      // queueing/prefill overhead, separate from TTFT and generation.
      headersMs = Date.now() - started;

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        const err = mapHttpError(res.status, bodyText, provider);
        // A 429 usually names its own wait (“retry-after: 30”); repeating the
        // request after 700 ms only burns the retry.
        const after = Number(res.headers?.get?.('retry-after'));
        if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(RETRY_AFTER_MAX_MS, after * 1000);
        if (err.code === 'RESPONSE_FORMAT' && useJsonMode && allowFormatRetry !== false) {
          useJsonMode = false;
          cleanup();
          continue; // immediate retry without JSON mode
        }
        throw err;
      }

      let text = '';
      let usage = { promptTokens: 0, completionTokens: 0 };
      let truncated = false;
      let finish = '';
      let ttftMs = 0;
      let usedModel = model;
      let generationId = '';
      let upstreamProvider = '';
      if (request.mode.endsWith('-sse') || request.mode === 'ollama-ndjson') {
        const parsed = await readStream(res, request.mode, { onDelta, signal: combined, startedAt: started, touchTransport, touchProgress });
        ttftMs = parsed.ttftMs || 0;
        if (parsed.model) usedModel = parsed.model;
        generationId = parsed.generationId || '';
        upstreamProvider = parsed.upstreamProvider || '';
        // A model that streams only its reasoning still said something; the
        // JSON it was asked for may be inside that trace.
        text = parsed.text || parsed.reasoning || '';
        usage = parsed.usage;
        finish = parsed.finish || '';
        truncated = TRUNCATION_FINISH.has(String(finish || '').toLowerCase());
      } else {
        const json = await res.json();
        // OpenRouter and a few gateways answer 200 with an error object instead
        // of an HTTP status; without this the run looked like an empty answer
        // and the real reason never reached the user.
        if (json && json.error) {
          const apiMessage = json.error.message || json.error.code || 'Провайдер вернул ошибку';
          if (looksLikeSafetyRefusal(String(apiMessage))) {
            throw safetyError(provider, String(apiMessage).slice(0, 300));
          }
          throw new AIError('PROVIDER_ERROR', String(apiMessage).slice(0, 300), {
            hint: 'Провайдер принял запрос, но отказал в ответе (например, модель недоступна). Попробуйте другую модель.',
            detail: JSON.stringify(json.error).slice(0, 400),
            provider: provider.name,
          });
        }
        text = finalText(request.mode, json);
        usage = usageFrom(request.mode, json);
        finish = json?.choices?.[0]?.finish_reason || json?.candidates?.[0]?.finishReason || json?.stop_reason || '';
        truncated = TRUNCATION_FINISH.has(String(finish || '').toLowerCase());
        if (typeof json?.model === 'string' && json.model) usedModel = json.model;
        if (typeof json?.id === 'string' && json.id) generationId = json.id;
        if (typeof json?.provider === 'string' && json.provider) upstreamProvider = json.provider;
      }
      if (!ttftMs) ttftMs = Date.now() - started;

      // The free router sometimes answers with a safety classifier's verdict
      // instead of a summary. This is a wrong-model route, not a refusal of the
      // content: retrying (the router picks another model each time) fixes it.
      // A real `content_filter` finish stays a refusal and is handled below.
      if (String(finish || '').toLowerCase() !== 'content_filter' && looksLikeSafetyVerdict(text)) {
        throw misroutedModelError(provider, text, usedModel);
      }

      // A safety refusal reaches this point as ordinary text (or as an empty
      // answer with finish: content_filter). It is a refusal, not a JSON bug:
      // the code lets the panel explain it and the chain move to another key.
      if (looksLikeSafetyRefusal(text, { finish })) {
        throw safetyError(provider, String(text || finish).slice(0, 400));
      }

      // A completely empty answer is a distinct failure, not a JSON problem:
      // the pipeline must not spend another full request on “repairing” it (that
      // is how a stuck free model produced nothing after several minutes).
      if (!String(text || '').trim()) {
        if (truncated) {
          throw new AIError('TRUNCATED', 'Модель израсходовала лимит и не вернула текст', {
            hint: 'Обычно так ведут себя «думающие» модели: весь бюджет уходит на рассуждение. Увеличьте «Максимум токенов ответа» в настройках, включите стратегию «фрагментами» или выберите модель без режима рассуждений.',
            provider: provider.name,
            detail: String(finish),
          });
        }
        throw emptyAnswerError(provider, { finish, usage });
      }

      cleanup();
      const latencyMs = Date.now() - started;
      return {
        text,
        usage,
        latencyMs,
        // `model` is the alias the caller asked for; `servedModel` is what the
        // provider says actually answered (openrouter/free routes per request).
        model: usedModel,
        requestedModel: model,
        ttftMs: ttftMs || latencyMs,
        headersMs,
        finishReason: finish,
        generationId,
        upstreamProvider,
        attempts: attempt,
        truncated,
      };
    } catch (err) {
      cleanup();
      const mapped = err instanceof AIError ? err : mapNetworkError(err, provider);
      lastError = mapped;
      // An external cancel (user stop, port teardown) ends the loop at once:
      // letting "retryable" verdicts drive further fetches would keep firing
      // requests after the caller stopped caring, and each of them would abort
      // the moment its wake-up check sees the dead signal.
      if (signal?.aborted) {
        // A deadline-driven abort deserves the deadline code even when the
        // fetch rejects with a generic AbortError. The abort reason is the
        // reliable signal: a fetch can reject synchronously on abort, a hair
        // before the recorded deadline instant, so a wall-clock check alone
        // reported a plain “aborted” detail. A user cancel carries a different
        // reason and keeps the mapped failure (tasks.js treats it as one).
        const abortReason = String(signal?.reason?.message || signal?.reason || '');
        if (/deadline/i.test(abortReason) || (effectiveDeadlineAt && Date.now() >= effectiveDeadlineAt - 50)) {
          throw operationDeadlineError(attempt, mapped);
        }
        mapped.attempts = attempt;
        mapped.elapsedMs = Date.now() - runStarted;
        throw mapped;
      }
      const retryable = mapped.retryable || mapped.code === 'NETWORK' || mapped.code === 'TIMEOUT';
      if (!retryable || attempt >= attemptLimit()) {
        // Failed attempts are part of the diagnosis: “one chunk took 90 s” is
        // often “four 20 s tries”, not one slow answer.
        mapped.attempts = attempt;
        mapped.elapsedMs = Date.now() - runStarted;
        throw mapped;
      }
      // Honour the provider's own wait; a plain 429 gets 15–45 s so the next
      // attempt lands outside a per-minute window instead of at 700 ms.
      const hinted = Number(mapped.retryAfterMs) || (mapped.code === 'RATE_LIMIT' ? 15000 : 0);
      const backoff = retryBackoffMs(attempt, hinted);
      // Waiting out a Retry-After that would outlive the operation deadline only
      // delays the same failure: report it now and issue no further request.
      if (effectiveDeadlineAt && remainingMs() <= backoff) throw operationDeadlineError(attempt, mapped);
      if (onRetry) onRetry({ attempt, code: mapped.code, waitMs: backoff });
      try {
        await sleep(backoff, signal);
      } catch {
        // Cancelled while waiting: the caller stopped caring, so no request
        // may be fired when the wait would have ended.
        mapped.attempts = attempt;
        mapped.elapsedMs = Date.now() - runStarted;
        throw mapped;
      }
    }
  }
  throw lastError || new AIError('UNKNOWN', 'Неизвестная ошибка провайдера');
}

/** Fetches the model list from the provider. */
export async function listModels({ provider, apiKey = '', timeoutMs = 15000 }) {
  const url = resolveModelsUrl(provider);
  if (!url) throw new AIError('NO_URL', 'Не задан базовый URL провайдера');
  const headers = { accept: 'application/json', ...authHeaders(provider, apiKey) };
  const finalUrl = withQueryKey(url, provider, apiKey);
  let res;
  try {
    res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined, credentials: 'omit' });
  } catch (err) {
    throw mapNetworkError(err, provider);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw mapHttpError(res.status, body, provider);
  }
  const json = await res.json();
  let models = [];
  if (Array.isArray(json?.data)) models = json.data.map((m) => m.id || m.name || m.model);
  else if (Array.isArray(json?.models)) {
    models = json.models
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || m.id || '').replace(/^models\//, ''));
  } else if (Array.isArray(json)) models = json.map((m) => m.id || m.name || m.model);
  else if (json?.data?.models) models = json.data.models.map((m) => m.id || m.name);
  const clean = Array.from(new Set(models.filter((m) => typeof m === 'string' && m)))
    .filter((m) => !/embed|whisper|tts|moderation|dall|image|audio|rerank|stable-diffusion|vision-ocr/i.test(m))
    .sort();
  return clean;
}

/** Cheap round-trip test used by the settings UI. */
export async function testProvider({ provider, apiKey = '', model, timeoutMs = 30000 }) {
  const started = Date.now();
  const { text, usage } = await chat({
    provider,
    apiKey,
    model,
    messages: [
      { role: 'system', content: 'Ты — тестовый ассистент. Отвечай предельно коротко.' },
      { role: 'user', content: 'Ответь ровно одним словом: pong' },
    ],
    temperature: 0,
    maxTokens: 24,
    stream: false,
    timeoutMs,
    retries: 0,
  });
  return {
    ok: true,
    latencyMs: Date.now() - started,
    sample: String(text || '').trim().slice(0, 80),
    usage,
    endpoint: resolveChatUrl(provider, model),
    host: (() => {
      try {
        return new URL(expandBaseUrl(provider)).host;
      } catch {
        return '';
      }
    })(),
  };
}

export { resolveChatUrl, resolveModelsUrl };
