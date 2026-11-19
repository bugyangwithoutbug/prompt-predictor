import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  loadConfig,
  maskApiKey,
  saveConfig,
  toPublicConfig,
} from '../lib/config.mjs';

test('config defaults, atomic save with 0600 permissions, key preservation and clearing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-cfg-'));
  const cfgPath = join(dir, 'settings.local.json');

  try {
    const initial = loadConfig(cfgPath);
    assert.deepEqual(initial, DEFAULT_CONFIG);
    assert.equal(initial.autoPredict, false);
    assert.equal(toPublicConfig(initial, cfgPath).configured, false);

    // Save API key
    const saved1 = saveConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-secret-4a2f',
    }, cfgPath);

    assert.equal(saved1.apiKey, 'sk-test-secret-4a2f');
    const mode = statSync(cfgPath).mode & 0o777;
    assert.equal(mode, 0o600);

    const pub1 = toPublicConfig(saved1, cfgPath);
    assert.equal('apiKey' in pub1, false);
    assert.equal(pub1.hasApiKey, true);
    assert.equal(pub1.apiKeyPreview, 'sk-…4a2f');
    assert.equal(pub1.configured, true);

    // Save patch with empty apiKey preserves existing key by default
    const saved2 = saveConfig({ model: 'gpt-4.1-mini', apiKey: '' }, cfgPath);
    assert.equal(saved2.model, 'gpt-4.1-mini');
    assert.equal(saved2.apiKey, 'sk-test-secret-4a2f');

    // clearApiKey removes it
    const saved3 = saveConfig({ clearApiKey: true }, cfgPath);
    assert.equal(saved3.apiKey, '');
    assert.equal(toPublicConfig(saved3, cfgPath).configured, false);

    // Switching baseUrl origin or provider clears old apiKey and rejects keepExistingKey
    saveConfig({ apiKey: 'sk-old-endpoint-1234' }, cfgPath);
    assert.throws(
      () => saveConfig({ baseUrl: 'https://other-gateway.example.com/v1', keepExistingKey: true }, cfgPath),
      /re-enter your API key/,
    );
    const switched = saveConfig({ baseUrl: 'https://other-gateway.example.com/v1' }, cfgPath);
    assert.equal(switched.apiKey, '');

    // Non-local http:// Base URL is rejected
    assert.throws(
      () => saveConfig({ baseUrl: 'http://remote.example.com/v1' }, cfgPath),
      /https:\/\//,
    );

    // Localhost endpoint does not require an API key and allows http://
    const localSaved = saveConfig({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    }, cfgPath);
    const pubLocal = toPublicConfig(localSaved, cfgPath);
    assert.equal(pubLocal.requiresApiKey, false);
    assert.equal(pubLocal.configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maskApiKey handles empty, short, and standard keys', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), '****');
  assert.equal(maskApiKey('sk-1234567890abcd'), 'sk-…abcd');
});

test('legacy pre-consent autoPredict=true on disk is disabled until explicitly confirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-legacy-'));
  const cfgPath = join(dir, 'settings.local.json');
  try {
    writeFileSync(cfgPath, JSON.stringify({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-legacy-1234',
      autoPredict: true,
    }), 'utf-8');

    const loaded = loadConfig(cfgPath);
    assert.equal(loaded.autoPredict, false);

    saveConfig({ autoPredict: true }, cfgPath);
    const reloaded = loadConfig(cfgPath);
    assert.equal(reloaded.autoPredict, true);
    assert.equal(reloaded.autoPredictConfirmed, true);

    // Legacy remote http:// Base URL must clear apiKey and mark unconfigured
    writeFileSync(cfgPath, JSON.stringify({
      provider: 'openai-compatible',
      baseUrl: 'http://legacy-gateway.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-legacy-http-9999',
      autoPredict: true,
      autoPredictConfirmed: true,
    }), 'utf-8');

    const legacyHttp = loadConfig(cfgPath);
    assert.equal(legacyHttp.baseUrl, 'https://api.openai.com/v1');
    assert.equal(legacyHttp.apiKey, '');
    assert.equal(legacyHttp.autoPredict, false);
    assert.equal(toPublicConfig(legacyHttp, cfgPath).configured, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
