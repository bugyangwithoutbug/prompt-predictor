import { setDefaultResultOrder } from 'node:dns';
import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { loadConfig, mergeConfig, saveConfig, toPublicConfig } from './lib/config.mjs';
import { generatePredictions, testConnection } from './lib/llm.mjs';
import { ID_RE, parseTranscriptState, resolveTranscriptPath } from './lib/transcript.mjs';

setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_CACHE_ENTRIES = 100;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const predictionCache = new Map(); // `${convId}:${turnKey}` -> { turnKey, suggestions, latencyMs, model, createdAt }
const inFlight = new Map(); // `${convId}:${turnKey}` -> Promise

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    contentType: 'application/json; charset=utf-8',
  });
}

function setCachedPrediction(cacheKey, entry) {
  if (predictionCache.has(cacheKey)) {
    predictionCache.delete(cacheKey);
  }
  predictionCache.set(cacheKey, entry);
  while (predictionCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = predictionCache.keys().next().value;
    predictionCache.delete(oldestKey);
  }
}

function readTranscriptForConversation(convId) {
  if (!convId || !ID_RE.test(convId)) {
    return {
      found: false,
      state: parseTranscriptState(''),
    };
  }
  const path = resolveTranscriptPath(convId);
  if (!path) {
    return {
      found: false,
      state: parseTranscriptState(''),
    };
  }
  try {
    const text = readFileSync(path, 'utf-8');
    return {
      found: true,
      state: parseTranscriptState(text),
    };
  } catch {
    return {
      found: false,
      state: parseTranscriptState(''),
    };
  }
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
}

// All data & mutation endpoints use POST so sidecar_sdk enforces X-Sidecar-Token.
app.api('/api/config/get', () => toPublicConfig(loadConfig()), 'POST');

app.api('/api/config', (data) => {
  const prev = loadConfig();
  let saved;
  try {
    saved = saveConfig(data);
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }

  if (
    prev.provider !== saved.provider ||
    prev.baseUrl !== saved.baseUrl ||
    prev.model !== saved.model ||
    prev.suggestionCount !== saved.suggestionCount ||
    prev.customInstructions !== saved.customInstructions
  ) {
    predictionCache.clear();
  }

  return toPublicConfig(saved);
}, 'POST');

app.api('/api/test-connection', async (data) => {
  const stored = loadConfig();
  let effective;
  try {
    effective = mergeConfig(stored, data, { strict: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const pub = toPublicConfig(effective);
  if (!pub.configured) {
    return { ok: false, error: 'Please enter an API key before testing.' };
  }

  try {
    const result = await testConnection(effective);
    console.log(`[predictor] test-connection ok model=${result.model} latencyMs=${result.latencyMs}`);
    return result;
  } catch (err) {
    console.error(`[predictor] test-connection failed model=${effective.model}: ${err.message}`);
    return { ok: false, error: err.message || 'Connection test failed.' };
  }
}, 'POST');

app.api('/api/state', (data) => {
  const convId = String(data.conversationId || app.config.conversationId || '').trim();
  const cfg = loadConfig();
  const pubCfg = toPublicConfig(cfg);
  const { state } = readTranscriptForConversation(convId);

  const cacheKey = convId && state.turnKey ? `${convId}:${state.turnKey}` : '';
  const hit = cacheKey ? predictionCache.get(cacheKey) || null : null;
  const predicting = Boolean(cacheKey && inFlight.has(cacheKey));

  return {
    conversationId: convId || null,
    status: state.status,
    turnEnded: state.turnEnded,
    turnKey: state.turnKey,
    messageCount: state.messageCount,
    lastReplyPreview: state.lastReplyPreview,
    configured: pubCfg.configured,
    autoPredict: pubCfg.autoPredict,
    predicting,
    cached: Boolean(hit),
    prediction: hit,
  };
}, 'POST');

app.api('/api/predict', async (data) => {
  const convId = String(data.conversationId || app.config.conversationId || '').trim();
  if (!convId || !ID_RE.test(convId)) {
    return jsonResponse({ error: 'Invalid or missing conversationId.' }, 400);
  }

  const cfg = loadConfig();
  const pubCfg = toPublicConfig(cfg);
  if (!pubCfg.configured) {
    return jsonResponse({ error: 'API key is not configured.' }, 400);
  }

  const force = Boolean(data.force);
  const workspaceNames = Array.isArray(data.workspaceNames) ? data.workspaceNames : [];
  const { state } = readTranscriptForConversation(convId);

  if (state.messageCount === 0 || (!state.turnEnded && !force)) {
    return {
      conversationId: convId,
      status: state.status,
      skipped: true,
    };
  }

  const turnKey = state.turnKey || `manual:${state.lastStepIndex}`;
  const cacheKey = `${convId}:${turnKey}`;

  if (!force && predictionCache.has(cacheKey)) {
    const cached = predictionCache.get(cacheKey);
    return {
      conversationId: convId,
      ...cached,
      cached: true,
    };
  }

  let promise = !force ? inFlight.get(cacheKey) : null;
  if (!promise) {
    promise = generatePredictions(cfg, state.messages, { workspaceNames })
      .then((result) => {
        console.log(
          `[predictor] predict ok model=${result.model} latencyMs=${result.latencyMs} count=${result.suggestions.length} finishReason=${result.finishReason || 'unknown'} reasoningTokens=${result.reasoningTokens ?? 'n/a'}`,
        );
        const entry = {
          turnKey,
          suggestions: result.suggestions,
          latencyMs: result.latencyMs,
          model: result.model,
          createdAt: Date.now(),
        };
        setCachedPrediction(cacheKey, entry);
        return entry;
      })
      .catch((err) => {
        console.error(`[predictor] predict failed model=${cfg.model}: ${err.message}`);
        throw err;
      })
      .finally(() => {
        if (inFlight.get(cacheKey) === promise) {
          inFlight.delete(cacheKey);
        }
      });
    inFlight.set(cacheKey, promise);
  }

  const entry = await promise;
  return {
    conversationId: convId,
    ...entry,
    cached: false,
  };
}, 'POST');

app.run();
