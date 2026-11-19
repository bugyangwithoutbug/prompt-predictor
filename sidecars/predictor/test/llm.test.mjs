import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildPredictionMessages, generatePredictions, parseSuggestions, redactSecrets, testConnection } from '../lib/llm.mjs';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      await handler(req, body ? JSON.parse(body) : {}, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('parseSuggestions extracts from JSON object, fenced JSON, raw array, and numbered lines', () => {
  const jsonObj = '{"suggestions":[{"text":"继续实现插件","label":"继续"},{"text":"先跑单测","label":"测试"},{"text":"继续实现插件","label":"重复"},{"text":"解释下架构","label":"疑问"}]}';
  assert.deepEqual(parseSuggestions(jsonObj, 3), [
    { text: '继续实现插件', label: '继续' },
    { text: '先跑单测', label: '测试' },
    { text: '解释下架构', label: '疑问' },
  ]);

  const fenced = 'Here are suggestions:\n```json\n[{"text":"Yes, proceed","label":"Confirm"},{"text":"Show diff first","label":"Review"}]\n```';
  assert.deepEqual(parseSuggestions(fenced, 3), [
    { text: 'Yes, proceed', label: 'Confirm' },
    { text: 'Show diff first', label: 'Review' },
  ]);

  const fallback = '1. 运行全部测试\n- 检查日志报错\n* 提交代码';
  assert.deepEqual(parseSuggestions(fallback, 2), [
    { text: '运行全部测试', label: '' },
    { text: '检查日志报错', label: '' },
  ]);
});

test('openai-compatible provider sends Bearer header and parses predictions + connection test', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (body.max_tokens === 16) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: [
              { text: '跑一下全部单测', label: '验证' },
              { text: '把配置示例补充完整', label: '文档' },
            ],
          }),
        },
      }],
    }));
  });

  try {
    const cfg = {
      provider: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-mock-openai',
      model: 'gpt-4o-mini',
      suggestionCount: 2,
    };

    const ping = await testConnection(cfg);
    assert.equal(ping.ok, true);
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer sk-mock-openai');

    const pred = await generatePredictions(cfg, [
      { role: 'user', text: '帮我写完插件' },
      { role: 'assistant', text: '已经写好了，接下来要运行测试吗？' },
    ]);
    assert.equal(pred.suggestions.length, 2);
    assert.equal(pred.suggestions[0].text, '跑一下全部单测');
  } finally {
    server.close();
  }
});

test('gemini provider uses x-goog-api-key header (not URL query) and handles HTTP errors', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push({ url: req.url, headerKey: req.headers['x-goog-api-key'], body });
    if (req.headers['x-goog-api-key'] === 'bad-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'API key invalid' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              suggestions: [
                { text: '好，开始验证', label: '确认' },
              ],
            }),
          }],
        },
      }],
    }));
  });

  try {
    const cfg = {
      provider: 'gemini',
      baseUrl,
      apiKey: 'gem-secret-key',
      model: 'gemini-2.5-flash',
      suggestionCount: 3,
    };

    const pred = await generatePredictions(cfg, [
      { role: 'user', text: '做吧' },
      { role: 'assistant', text: '准备好了，要开始验证吗？' },
    ]);
    assert.equal(seen[0].url, '/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(seen[0].url.includes('gem-secret-key'), false);
    assert.equal(seen[0].headerKey, 'gem-secret-key');
    assert.equal(pred.suggestions[0].text, '好，开始验证');

    await assert.rejects(
      () => testConnection({ ...cfg, apiKey: 'bad-key' }),
      /HTTP 401/,
    );
  } finally {
    server.close();
  }
});

test('gpt-5* models use max_completion_tokens and omit temperature on first request', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push(body);
    if ('max_tokens' in body || 'temperature' in body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported parameter' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: [{ text: '继续测试', label: '测试' }],
          }),
        },
      }],
    }));
  });

  try {
    const cfg = {
      provider: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-test-gpt5',
      model: 'gpt-5-mini',
      suggestionCount: 3,
    };

    const ping = await testConnection(cfg);
    assert.equal(ping.ok, true);
    assert.equal(seen[0].max_tokens, undefined);
    assert.equal(seen[0].temperature, undefined);
    assert.equal(seen[0].max_completion_tokens, 256);
    assert.equal(seen[0].reasoning_effort, 'low');

    const pred = await generatePredictions(cfg, [
      { role: 'user', text: '测试一下' },
      { role: 'assistant', text: '已完成，是否继续？' },
    ]);
    assert.equal(seen[1].max_tokens, undefined);
    assert.equal(seen[1].temperature, undefined);
    assert.equal(seen[1].max_completion_tokens, 2048);
    assert.equal(seen[1].reasoning_effort, 'low');
    assert.equal(pred.suggestions[0].text, '继续测试');
  } finally {
    server.close();
  }
});

test('gpt-6.2-sol sends max_completion_tokens and reasoning_effort=low on first request', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push({ ...body });
    if ('max_tokens' in body || 'temperature' in body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unsupported parameter' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            suggestions: [{ text: '继续运行验证', label: '验证' }],
          }),
        },
      }],
      usage: { completion_tokens_details: { reasoning_tokens: 42 } },
    }));
  });

  try {
    const cfg = {
      provider: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-test-gpt62',
      model: 'gpt-6.2-sol',
      suggestionCount: 3,
    };

    const ping = await testConnection(cfg);
    assert.equal(ping.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].max_tokens, undefined);
    assert.equal(seen[0].temperature, undefined);
    assert.equal(seen[0].max_completion_tokens, 256);
    assert.equal(seen[0].reasoning_effort, 'low');

    const pred = await generatePredictions(cfg, [
      { role: 'user', text: '修好了吗' },
      { role: 'assistant', text: '已修改完成，现在要测试吗？' },
    ]);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].max_tokens, undefined);
    assert.equal(seen[1].temperature, undefined);
    assert.equal(seen[1].max_completion_tokens, 2048);
    assert.equal(seen[1].reasoning_effort, 'low');
    assert.equal(pred.suggestions[0].text, '继续运行验证');
    assert.equal(pred.finishReason, 'stop');
    assert.equal(pred.reasoningTokens, 42);
  } finally {
    server.close();
  }
});

test('finish_reason=length with empty content throws clear token budget error', async () => {
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'length',
        message: { content: '' },
      }],
      usage: { completion_tokens_details: { reasoning_tokens: 2048 } },
    }));
  });

  try {
    await assert.rejects(
      () => generatePredictions(
        {
          provider: 'openai-compatible',
          baseUrl: `${baseUrl}/v1`,
          apiKey: 'sk-test-len',
          model: 'gpt-6.2-sol',
          suggestionCount: 3,
        },
        [
          { role: 'user', text: '帮我继续' },
          { role: 'assistant', text: '好的，接下来要怎么做？' },
        ],
      ),
      /finish_reason=length, reasoning_tokens=2048/,
    );
  } finally {
    server.close();
  }
});

test('drops reasoning_effort automatically if model rejects it with HTTP 400', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push({ ...body });
    if (body.reasoning_effort !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
          type: 'invalid_request_error',
          param: 'reasoning_effort',
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });

  try {
    const res = await testConnection({
      provider: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-test-o1',
      model: 'o1',
    });
    assert.equal(res.ok, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].reasoning_effort, 'low');
    assert.equal(seen[1].reasoning_effort, undefined);
  } finally {
    server.close();
  }
});

test('slow endpoint formats clear timeout error without leaking apiKey', async () => {
  const secretKey = 'sk-super-secret-do-not-leak';
  const { server, baseUrl } = await startMockServer(async (req, body, res) => {
    await new Promise((r) => setTimeout(r, 300));
    if (!res.writableEnded) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    }
  });

  try {
    await assert.rejects(
      () => testConnection(
        {
          provider: 'openai-compatible',
          baseUrl: `${baseUrl}/v1`,
          apiKey: secretKey,
          model: 'gpt-5-mini',
        },
        { timeoutMs: 50 },
      ),
      (err) => {
        assert.match(err.message, /Request timed out after \d+s/);
        assert.match(err.message, /\/v1\/chat\/completions/);
        assert.match(err.message, /model=gpt-5-mini/);
        assert.equal(err.message.includes(secretKey), false);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('unknown alias model falls back automatically on HTTP 400 max_tokens and temperature errors', async () => {
  const seen = [];
  const { server, baseUrl } = await startMockServer((req, body, res) => {
    seen.push({ ...body });
    if (body.max_tokens !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          type: 'invalid_request_error',
          param: 'max_tokens',
          code: 'unsupported_parameter',
        },
      }));
      return;
    }
    if (body.temperature !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "Unsupported value: 'temperature' does not support 0.4 with this model. Only the default (1) value is supported.",
          type: 'invalid_request_error',
          param: 'temperature',
          code: 'unsupported_value',
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            suggestions: [{ text: '查看返回结果', label: '检查' }],
          }),
        },
      }],
    }));
  });

  try {
    const cfg = {
      provider: 'openai-compatible',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-test-alias',
      model: 'custom-reasoning-alias',
      suggestionCount: 2,
    };

    const pred = await generatePredictions(cfg, [
      { role: 'user', text: '试试别名模型' },
      { role: 'assistant', text: '请确认下一步操作' },
    ]);
    assert.equal(seen.length, 3);
    assert.equal(seen[0].max_tokens, 640);
    assert.equal(seen[1].max_tokens, undefined);
    assert.equal(seen[1].max_completion_tokens, 2048);
    assert.equal(seen[1].reasoning_effort, 'low');
    assert.equal(seen[1].temperature, 0.4);
    assert.equal(seen[2].max_completion_tokens, 2048);
    assert.equal(seen[2].reasoning_effort, 'low');
    assert.equal(seen[2].temperature, undefined);
    assert.equal(pred.suggestions[0].text, '查看返回结果');
  } finally {
    server.close();
  }
});

test('retries transient fetch failed errors and surfaces underlying cause on persistent failure', async () => {
  let calls = 0;
  const transientFetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const okRes = await testConnection(
    { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini' },
    { fetchImpl: transientFetch },
  );
  assert.equal(okRes.ok, true);
  assert.equal(calls, 2);

  const failingFetch = async () => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' }),
    });
  };

  await assert.rejects(
    () => testConnection(
      { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini' },
      { fetchImpl: failingFetch },
    ),
    /fetch failed \| ECONNRESET: Connection reset by peer/,
  );
});

test('redacts secrets in outbound prediction messages and upstream error logs', async () => {
  const { user } = buildPredictionMessages([
    {
      role: 'user',
      text: 'Test with key sk-proj-realSecretValue12345 and ghp_abcdefghijklmnopqrstuv and Bearer myJwtSecretToken12345 and api_key=superSecretPass99',
    },
  ]);
  assert.equal(user.includes('sk-proj-realSecretValue12345'), false);
  assert.equal(user.includes('ghp_abcdefghijklmnopqrstuv'), false);
  assert.equal(user.includes('myJwtSecretToken12345'), false);
  assert.equal(user.includes('superSecretPass99'), false);
  assert.match(user, /\[REDACTED_KEY\]/);
  assert.match(user, /\[REDACTED_TOKEN\]/);
  assert.match(user, /Bearer \[REDACTED\]/);

  const echoErrFetch = async () => new Response(
    JSON.stringify({
      error: {
        code: 'bad_gateway',
        message: 'Upstream echoed sk-echoedSecret1234567890 in error',
      },
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } },
  );

  await assert.rejects(
    () => testConnection(
      { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini' },
      { fetchImpl: echoErrFetch },
    ),
    (err) => {
      assert.equal(err.message.includes('sk-echoedSecret1234567890'), false);
      assert.match(err.message, /HTTP 502: bad_gateway: Upstream echoed \[REDACTED_KEY\]/);
      return true;
    },
  );
  assert.equal(redactSecrets('plain text'), 'plain text');
});

test('blocks HTTP redirects and drops raw non-JSON upstream error bodies from logs', async () => {
  const { server: targetServer, baseUrl: targetUrl } = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'SHOULD_NOT_REACH' } }] }));
  });
  let targetHit = false;
  targetServer.on('request', () => { targetHit = true; });

  const { server: redirServer, baseUrl: redirUrl } = await startMockServer((req, body, res) => {
    res.writeHead(307, { Location: `${targetUrl}/v1/chat/completions` });
    res.end();
  });

  try {
    await assert.rejects(
      () => testConnection({
        provider: 'openai-compatible',
        baseUrl: `${redirUrl}/v1`,
        apiKey: 'sk-should-not-follow',
        model: 'gpt-4o-mini',
      }),
      /redirects are blocked/,
    );
    assert.equal(targetHit, false);
  } finally {
    redirServer.close();
    targetServer.close();
  }

  const nonJsonErrFetch = async () => new Response(
    '<html>Gateway raw echo: sensitive-internal-payload</html>',
    {
      status: 502,
      headers: {
        'Content-Type': 'text/html',
        'x-request-id': 'req_abc123',
      },
    },
  );

  await assert.rejects(
    () => testConnection(
      { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini' },
      { fetchImpl: nonJsonErrFetch },
    ),
    (err) => {
      assert.equal(err.message, 'HTTP 502 (request_id=req_abc123)');
      assert.equal(err.safeLog, 'HTTP 502 (request_id=req_abc123)');
      assert.equal(err.message.includes('sensitive-internal-payload'), false);
      return true;
    },
  );
});
