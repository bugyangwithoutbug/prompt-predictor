import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ALLOWED_PROVIDERS = new Set(['openai-compatible', 'gemini']);

export const DEFAULT_CONFIG = Object.freeze({
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  autoPredict: false,
  autoPredictConfirmed: false,
  suggestionCount: 3,
  customInstructions: '',
});

/** Resolve the active configuration file path. */
export function getConfigPath(overridePath) {
  if (typeof overridePath === 'string' && overridePath.trim()) {
    return overridePath.trim();
  }
  const envPath = process.env.PREDICTOR_CONFIG_PATH;
  if (typeof envPath === 'string' && envPath.trim()) {
    return envPath.trim();
  }
  return join(homedir(), '.gemini', 'config', 'plugins', 'prompt-predictor', 'settings.local.json');
}

/** Mask an API key for safe display in the UI and public config responses. */
export function maskApiKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.length < 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Return true if the URL targets localhost/loopback where API keys and HTTP are allowed. */
export function isLocalhostUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

export function getEndpointOrigin(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).origin.toLowerCase();
  } catch {
    return '';
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeBaseUrlString(value, provider) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed) return trimmed;
  return provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com'
    : DEFAULT_CONFIG.baseUrl;
}

function validateBaseUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Base URL must be a valid http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL protocol must be http: or https:.');
  }
  if (parsed.protocol === 'http:' && !isLocalhostUrl(urlStr)) {
    throw new Error('Non-local Base URL must use https://.');
  }
}

/** Merge a partial update onto a base config, validating and normalizing fields. */
export function mergeConfig(base, patch = {}, { strict = true } = {}) {
  const prev = base || DEFAULT_CONFIG;
  const p = patch && typeof patch === 'object' ? patch : {};

  let provider = prev.provider || DEFAULT_CONFIG.provider;
  if (p.provider !== undefined) {
    const candidate = String(p.provider).trim();
    if (!ALLOWED_PROVIDERS.has(candidate)) {
      if (strict) throw new Error(`Unsupported provider: ${candidate}`);
    } else {
      provider = candidate;
    }
  }

  let baseUrl = normalizeBaseUrlString(
    p.baseUrl !== undefined ? p.baseUrl : prev.baseUrl,
    provider,
  );
  let invalidPersistedUrl = false;
  if (strict) {
    validateBaseUrl(baseUrl);
  } else {
    try {
      validateBaseUrl(baseUrl);
    } catch {
      invalidPersistedUrl = true;
      baseUrl = normalizeBaseUrlString('', provider);
    }
  }

  let model = p.model !== undefined ? String(p.model).trim() : (prev.model || DEFAULT_CONFIG.model);
  if (!model) {
    if (strict) throw new Error('Model name cannot be empty.');
    model = provider === 'gemini' ? 'gemini-2.5-flash' : DEFAULT_CONFIG.model;
  }

  const prevEndpoint = `${prev.provider || DEFAULT_CONFIG.provider}:${getEndpointOrigin(prev.baseUrl || DEFAULT_CONFIG.baseUrl)}`;
  const nextEndpoint = `${provider}:${getEndpointOrigin(baseUrl)}`;
  const endpointChanged = Boolean(prev.apiKey) && prevEndpoint !== nextEndpoint;

  let apiKey = typeof prev.apiKey === 'string' ? prev.apiKey : '';
  if (invalidPersistedUrl || p.clearApiKey === true) {
    apiKey = '';
  } else if (typeof p.apiKey === 'string' && p.apiKey.trim()) {
    apiKey = p.apiKey.trim();
  } else if (endpointChanged) {
    if (strict && p.keepExistingKey === true && !isLocalhostUrl(baseUrl)) {
      throw new Error('Provider or Base URL changed — please re-enter your API key.');
    }
    apiKey = '';
  } else if (typeof p.apiKey === 'string' && !p.apiKey.trim() && p.keepExistingKey === false) {
    apiKey = '';
  }

  let autoPredictConfirmed = Boolean(prev.autoPredictConfirmed);
  let autoPredict = typeof prev.autoPredict === 'boolean' ? prev.autoPredict : DEFAULT_CONFIG.autoPredict;
  if (invalidPersistedUrl) {
    autoPredict = false;
    autoPredictConfirmed = false;
  } else if (p.autoPredict !== undefined) {
    autoPredict = Boolean(p.autoPredict);
    if (strict) {
      autoPredictConfirmed = autoPredict;
    } else {
      autoPredictConfirmed = Boolean(p.autoPredictConfirmed === true);
      if (!autoPredictConfirmed) {
        autoPredict = false;
      }
    }
  } else if (!strict && !autoPredictConfirmed) {
    autoPredict = false;
  }

  const suggestionCount = clampInt(
    p.suggestionCount !== undefined ? p.suggestionCount : prev.suggestionCount,
    1,
    5,
    DEFAULT_CONFIG.suggestionCount,
  );

  const customInstructions = p.customInstructions !== undefined
    ? String(p.customInstructions).trim().slice(0, 500)
    : String(prev.customInstructions || '').trim().slice(0, 500);

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    autoPredict,
    autoPredictConfirmed,
    suggestionCount,
    customInstructions,
  };
}

/** Load persisted config merged with defaults. */
export function loadConfig(configPath) {
  const target = getConfigPath(configPath);
  if (!existsSync(target)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(target, 'utf-8'));
    return mergeConfig(DEFAULT_CONFIG, raw, { strict: false });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Atomically persist a config patch with mode 0600 permissions. */
export function saveConfig(patch, configPath) {
  const target = getConfigPath(configPath);
  const current = loadConfig(target);
  const next = mergeConfig(current, patch, { strict: true });

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    chmodSync(target, 0o600);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }

  return next;
}

/** Convert full config into a redacted public object safe for GET endpoints. */
export function toPublicConfig(cfg, configPath) {
  const safeCfg = cfg || DEFAULT_CONFIG;
  const hasApiKey = Boolean(safeCfg.apiKey);
  const requiresApiKey = !(safeCfg.provider === 'openai-compatible' && isLocalhostUrl(safeCfg.baseUrl));
  return {
    provider: safeCfg.provider,
    baseUrl: safeCfg.baseUrl,
    model: safeCfg.model,
    autoPredict: safeCfg.autoPredict,
    suggestionCount: safeCfg.suggestionCount,
    customInstructions: safeCfg.customInstructions,
    hasApiKey,
    apiKeyPreview: maskApiKey(safeCfg.apiKey),
    requiresApiKey,
    configured: hasApiKey || !requiresApiKey,
    configPath: getConfigPath(configPath),
  };
}
