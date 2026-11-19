import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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

    // Localhost endpoint does not require an API key
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
