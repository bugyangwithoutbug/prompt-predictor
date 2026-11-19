/**
 * LLM clients and prompt/response helpers for Prompt Predictor.
 * Zero external dependencies; uses Node's built-in fetch and AbortSignal.timeout.
 */

function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function normalizeUrlBase(rawUrl, defaultUrl) {
  return String(rawUrl || defaultUrl).trim().replace(/\/+$/, '');
}

function buildOpenAIChatUrl(baseUrl) {
  const base = normalizeUrlBase(baseUrl, 'https://api.openai.com/v1');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function buildGeminiGenerateUrl(baseUrl, model) {
  let base = normalizeUrlBase(baseUrl, 'https://generativelanguage.googleapis.com');
  if (base.endsWith(':generateContent')) return base;
  if (base.endsWith('/v1beta') || base.endsWith('/v1')) {
    base = base.replace(/\/v1(?:beta)?$/, '');
  }
  return `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

/** Redact common API keys, bearer tokens, and credential assignments before outbound/log use. */
export function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]')
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_TOKEN]')
    .replace(
      /\b(api[_-]?key|secret|token|password)\b(\s*[:=]\s*)(['"]?)([^\s'",;]{8,})\3/gi,
      '$1$2$3[REDACTED]$3',
    );
}

/** Build system & user messages for next-prompt prediction. */
export function buildPredictionMessages(dialogue, options = {}) {
  const count = clampCount(options.count ?? 3);
  const customInstructions = typeof options.customInstructions === 'string'
    ? redactSecrets(options.customInstructions.trim().slice(0, 500))
    : '';
  const workspaceNames = Array.isArray(options.workspaceNames)
    ? options.workspaceNames.map((w) => String(w || '').trim()).filter(Boolean)
    : [];

  const systemLines = [
    'You are a Codex-style composer predictor inside an AI coding assistant.',
    `Predict the ${count} most likely next messages the user will type next, ranked from most likely to least likely.`,
    'Rules:',
    '- Match the user\'s exact language (Chinese, English, or mixed) and natural, direct tone.',
    '- Suggestion #1 MUST always be the single most recommended, highest-value next step; #2 and #3 should be distinct, meaningful alternatives.',
    '- If the assistant\'s last message asked a question, offered choices, or suggested a next step, the #1 prediction should directly answer, confirm, or select the most likely option.',
    '- Write complete, self-contained, actionable prompts (~35-80 Chinese chars or ~15-40 English words, roughly 2-3 lines) rather than overly terse fragments.',
    '- Include concrete context from the conversation (specific files, modules, constraints, focus points, or what to check/avoid) so the user can send it directly without rewriting.',
    '- Keep each prompt to 1-2 natural sentences (no bullet lists, no filler, no essays).',
    '- Do not repeat the assistant\'s response; write from the user\'s perspective.',
    '- Output strictly valid JSON matching {"suggestions":[{"text":"...","label":"2-4字短标签"}]} with no markdown fences or extra text.',
  ];
  if (customInstructions) {
    systemLines.push(`User preference: ${customInstructions}`);
  }

  const transcriptLines = [];
  if (workspaceNames.length > 0) {
    transcriptLines.push(`Active workspace: ${workspaceNames.join(', ')}`);
    transcriptLines.push('');
  }
  for (const msg of dialogue || []) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
    transcriptLines.push(`${roleLabel}: ${redactSecrets(msg.text)}`);
  }
  transcriptLines.push('');
  transcriptLines.push(`Return exactly ${count} ranked next-user-prompt predictions as JSON.`);

  return {
    system: systemLines.join('\n'),
    user: transcriptLines.join('\n'),
  };
}

function normalizeSuggestionList(items, count) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    let text = '';
    let label = '';
    if (typeof item === 'string') {
      text = item.trim();
    } else if (item && typeof item === 'object') {
      text = String(item.text ?? item.prompt ?? item.suggestion ?? item.content ?? '').trim();
      label = String(item.label ?? item.tag ?? item.intent ?? '').trim().slice(0, 16);
    }
    if (!text) continue;
    const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ text, label });
    if (out.length >= count) break;
  }

  return out;
}

function tryParseJsonCandidate(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str.trim());
  } catch {
    return null;
  }
}

/** Extract normalized suggestion objects from structured or plain-text LLM output. */
export function parseSuggestions(rawText, count = 3) {
  const limit = clampCount(count);
  const text = String(rawText || '').trim();
  if (!text) return [];

  const candidates = [text];
  const fenceMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fenceMatches) {
    if (m[1]) candidates.push(m[1]);
  }
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    candidates.push(text.slice(objStart, objEnd + 1));
  }
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    candidates.push(text.slice(arrStart, arrEnd + 1));
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (!parsed) continue;
    if (Array.isArray(parsed)) {
      const normalized = normalizeSuggestionList(parsed, limit);
      if (normalized.length > 0) return normalized;
    } else if (parsed && typeof parsed === 'object') {
      const list = parsed.suggestions || parsed.predictions || parsed.prompts || parsed.items;
      if (Array.isArray(list)) {
        const normalized = normalizeSuggestionList(list, limit);
        if (normalized.length > 0) return normalized;
      }
    }
  }

  // Fallback: line-based extraction for weak models that omit JSON
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line))
    .map((line) => line.replace(/^(?:\d+[.)]\s*|[-*•]\s+)/, '').trim())
    .filter((line) => line && !/^[\[\]{},]+$/.test(line))
    .map((line) => line.replace(/^["']|["']$/g, '').trim());

  return normalizeSuggestionList(lines, limit);
}

function extractOpenAIContent(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String(part?.text || '')))
      .join('');
  }
  return '';
}

function extractGeminiContent(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => String(p?.text || '')).join('');
}

function usesMaxCompletionTokens(model) {
  return /(?:^|\/)(?:o[1-9]\d*|gpt-(?:[5-9]|[1-9]\d+))(?:\b|[-_.])/i.test(String(model || '').trim());
}

const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function formatFetchError(err) {
  const parts = [err?.message || 'Network error'];
  let cur = err?.cause;
  let depth = 0;
  while (cur && depth < 3) {
    const detail = [cur.code, cur.message].filter(Boolean).join(': ');
    if (detail && !parts.includes(detail)) parts.push(detail);
    cur = cur.cause;
    depth += 1;
  }
  return parts.join(' | ');
}

function isTransientNetworkError(err) {
  if (!err || err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message || '')) return true;
  let cur = err;
  for (let i = 0; i < 3 && cur; i += 1) {
    if (cur.code && TRANSIENT_NET_CODES.has(cur.code)) return true;
    cur = cur.cause;
  }
  return false;
}

async function callProvider(cfg, { system, user, maxTokens, isPing = false, responseMimeType, timeoutMs, fetchImpl }) {
  const provider = cfg.provider || 'openai-compatible';
  const model = cfg.model;
  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';

  let url;
  const headers = { 'Content-Type': 'application/json' };
  let payload;

  if (provider === 'gemini') {
    url = buildGeminiGenerateUrl(cfg.baseUrl, model);
    if (apiKey) {
      headers['x-goog-api-key'] = apiKey;
    }
    const generationConfig = {
      temperature: 0.4,
      maxOutputTokens: maxTokens,
    };
    if (responseMimeType) {
      generationConfig.responseMimeType = responseMimeType;
    }
    payload = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig,
    };
  } else {
    url = buildOpenAIChatUrl(cfg.baseUrl);
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    if (usesMaxCompletionTokens(model)) {
      payload = {
        model,
        messages,
        max_completion_tokens: Math.max(maxTokens, isPing ? 256 : 2048),
        reasoning_effort: 'low',
      };
    } else {
      payload = {
        model,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
      };
    }
  }

  let droppedReasoningEffort = false;
  let netRetries = 0;
  const startedAt = performance.now();
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const json = await res.json();
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
        const rawText = provider === 'gemini' ? extractGeminiContent(json) : extractOpenAIContent(json);
        const finishReason = provider === 'gemini'
          ? (json?.candidates?.[0]?.finishReason || null)
          : (json?.choices?.[0]?.finish_reason || null);
        const reasoningTokens = json?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
        return { rawText, json, latencyMs, finishReason, reasoningTokens };
      }
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s (${url}, model=${model}). Check network/proxy or try a faster model.`);
      }
      if (/redirect/i.test(err?.message || '') || /redirect/i.test(err?.cause?.message || '')) {
        throw new Error(`Request redirected from ${url} (redirects are blocked for security).`);
      }
      if (isTransientNetworkError(err) && netRetries < 2) {
        netRetries += 1;
        await new Promise((r) => setTimeout(r, 250 * netRetries));
        continue;
      }
      throw new Error(formatFetchError(err));
    }

    const requestId = res.headers?.get?.('x-request-id')
      || res.headers?.get?.('request-id')
      || res.headers?.get?.('cf-ray')
      || '';

    let errCode = '';
    let errMsg = '';
    try {
      const text = await res.text();
      const parsedErr = JSON.parse(text);
      const errObj = parsedErr?.error;
      if (errObj && typeof errObj === 'object') {
        errCode = String(errObj.code || errObj.type || '').replace(/\s+/g, ' ').trim().slice(0, 64);
        errMsg = errObj.message ? redactSecrets(String(errObj.message)).replace(/\s+/g, ' ').trim() : '';
      }
    } catch {
      // Non-JSON or unreadable upstream error body: never echo raw text
    }

    const fallbackText = `${errCode} ${errMsg}`;
    if (provider !== 'gemini' && res.status === 400 && attempt < 5) {
      if (
        payload.max_tokens !== undefined &&
        fallbackText.includes('max_completion_tokens') &&
        fallbackText.includes('max_tokens')
      ) {
        payload.max_completion_tokens = Math.max(payload.max_tokens, isPing ? 256 : 2048);
        delete payload.max_tokens;
        if (!droppedReasoningEffort && payload.reasoning_effort === undefined) {
          payload.reasoning_effort = 'low';
        }
        continue;
      }
      if (
        payload.temperature !== undefined &&
        fallbackText.toLowerCase().includes('temperature')
      ) {
        delete payload.temperature;
        continue;
      }
      if (
        payload.reasoning_effort !== undefined &&
        fallbackText.toLowerCase().includes('reasoning_effort')
      ) {
        droppedReasoningEffort = true;
        delete payload.reasoning_effort;
        continue;
      }
    }

    const structured = [errCode, errMsg].filter(Boolean).join(': ').slice(0, 240);
    const reqSuffix = requestId ? ` (request_id=${requestId})` : '';
    const outErr = new Error(`HTTP ${res.status}${structured ? `: ${structured}` : ''}${reqSuffix}`);
    outErr.safeLog = `HTTP ${res.status}${errCode ? ` code=${errCode}` : ''}${reqSuffix}`;
    throw outErr;
  }
}

/** Call configured provider to generate ranked next-prompt suggestions. */
export async function generatePredictions(cfg, dialogue, options = {}) {
  if (!Array.isArray(dialogue) || dialogue.length === 0) {
    throw new Error('Cannot generate predictions without conversation history.');
  }

  const count = clampCount(cfg.suggestionCount ?? 3);
  const timeoutMs = options.timeoutMs ?? 30000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const { system, user } = buildPredictionMessages(dialogue, {
    count,
    customInstructions: cfg.customInstructions,
    workspaceNames: options.workspaceNames,
  });

  const { rawText, latencyMs, finishReason, reasoningTokens } = await callProvider(cfg, {
    system,
    user,
    maxTokens: 640,
    isPing: false,
    responseMimeType: cfg.provider === 'gemini' ? 'application/json' : undefined,
    timeoutMs,
    fetchImpl,
  });

  const suggestions = parseSuggestions(rawText, count);
  if (suggestions.length === 0) {
    if (finishReason === 'length') {
      throw new Error(
        `Model exhausted token budget before outputting suggestions (finish_reason=length${reasoningTokens != null ? `, reasoning_tokens=${reasoningTokens}` : ''}).`,
      );
    }
    throw new Error('Model returned no usable suggestions.');
  }

  return {
    suggestions,
    latencyMs,
    model: cfg.model,
    finishReason,
    reasoningTokens,
  };
}

/** Verify provider endpoint, credentials, and model with a minimal prompt. */
export async function testConnection(cfg, options = {}) {
  const timeoutMs = options.timeoutMs ?? 25000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const { json, latencyMs } = await callProvider(cfg, {
    system: '',
    user: 'Reply OK.',
    maxTokens: 16,
    isPing: true,
    timeoutMs,
    fetchImpl,
  });

  const hasChoice = cfg.provider === 'gemini'
    ? Array.isArray(json?.candidates) && json.candidates.length > 0
    : Array.isArray(json?.choices) && json.choices.length > 0;

  if (!hasChoice) {
    throw new Error('Provider returned an unexpected empty response.');
  }

  return {
    ok: true,
    latencyMs,
    model: cfg.model,
  };
}
