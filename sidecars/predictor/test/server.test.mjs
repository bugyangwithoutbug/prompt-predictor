import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_PATH = join(__dirname, '..', 'main.mjs');
const LOADER_PATH = process.env.SIDECAR_SDK_LOADER
  || join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'register_loader.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sidecar exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      if (res.ok) return;
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for sidecar server');
}

test('predictor sidecar HTTP routes, token auth, state polling, and prediction cache', async (t) => {
  let llmCalls = 0;
  const mockLlm = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (parsed.max_tokens === 16) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      return;
    }
    llmCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: [
              { text: '运行集成测试', label: '验证' },
              { text: '查看插件目录', label: '检查' },
              { text: '调整提示词', label: '优化' },
            ],
          }),
        },
      }],
    }));
  });

  await new Promise((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
  const llmPort = mockLlm.address().port;

  const tempDir = mkdtempSync(join(tmpdir(), 'pp-srv-'));
  const cfgPath = join(tempDir, 'settings.local.json');
  const convId = '00000000-0000-4000-8000-000000000001';
  const logsDir = join(tempDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n那我额外配key\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: '插件已创建，接下来可以运行测试验证。' }),
    ].join('\n') + '\n',
    'utf-8',
  );

  const webPort = await getFreePort();
  const uiToken = 'test-ui-token-123';
  const sidecarUrl = `http://127.0.0.1:${webPort}`;

  const child = spawn(
    process.execPath,
    ['--import', LOADER_PATH, MAIN_PATH],
    {
      env: {
        ...process.env,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:5387',
        ANTIGRAVITY_CSRF_TOKEN: 'dummy-csrf',
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(webPort),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
        PREDICTOR_CONFIG_PATH: cfgPath,
        PREDICTOR_APP_DATA_DIR: tempDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
    mockLlm.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(sidecarUrl, child);

  // Static assets
  for (const route of ['/', '/preload.js', '/app.js', '/styles.css']) {
    const res = await fetch(`${sidecarUrl}${route}`);
    assert.equal(res.status, 200, `Expected 200 for ${route}; stderr=${stderr}`);
  }

  // Token auth check on POST /api/config
  const unauthRes = await fetch(`${sidecarUrl}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'gpt-4o-mini', apiKey: 'sk-live-9999' }),
  });
  assert.equal(unauthRes.status, 401);

  const saveRes = await fetch(`${sidecarUrl}/api/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': uiToken,
    },
    body: JSON.stringify({
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${llmPort}/v1`,
      model: 'gpt-4o-mini',
      apiKey: 'sk-live-9999',
    }),
  });
  assert.equal(saveRes.status, 200);
  const savedPub = await saveRes.json();
  assert.equal('apiKey' in savedPub, false);
  assert.equal(savedPub.hasApiKey, true);
  assert.equal(savedPub.apiKeyPreview, 'sk-…9999');

  // GET /api/config never returns raw apiKey
  const getCfg = await (await fetch(`${sidecarUrl}/api/config`)).json();
  assert.equal('apiKey' in getCfg, false);
  assert.equal(getCfg.configured, true);

  // GET /api/state detects turnEnded
  const st = await (await fetch(`${sidecarUrl}/api/state?conversationId=${convId}`)).json();
  assert.equal(st.turnEnded, true);
  assert.equal(st.turnKey, '1');
  assert.equal(st.cached, false);

  // POST /api/test-connection
  const testConnRes = await fetch(`${sidecarUrl}/api/test-connection`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': uiToken,
    },
    body: JSON.stringify({ keepExistingKey: true }),
  });
  assert.equal(testConnRes.status, 200);
  const testConnJson = await testConnRes.json();
  assert.equal(testConnJson.ok, true);

  // POST /api/predict twice -> hits LLM once, second call served from cache
  const pred1Res = await fetch(`${sidecarUrl}/api/predict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': uiToken,
    },
    body: JSON.stringify({ conversationId: convId }),
  });
  assert.equal(pred1Res.status, 200);
  const pred1 = await pred1Res.json();
  assert.equal(pred1.suggestions.length, 3);
  assert.equal(pred1.cached, false);
  assert.equal(llmCalls, 1);

  const pred2 = await (await fetch(`${sidecarUrl}/api/predict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': uiToken,
    },
    body: JSON.stringify({ conversationId: convId }),
  })).json();
  assert.equal(pred2.cached, true);
  assert.equal(llmCalls, 1);

  // force: true hits mock LLM again
  const pred3 = await (await fetch(`${sidecarUrl}/api/predict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': uiToken,
    },
    body: JSON.stringify({ conversationId: convId, force: true }),
  })).json();
  assert.equal(pred3.cached, false);
  assert.equal(llmCalls, 2);
});
