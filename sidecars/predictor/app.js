(() => {
  const POLL_MS = 1500;
  const ERROR_COOLDOWN_MS = 30000;

  const PRESETS = {
    openai: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    },
    gemini: {
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.5-flash',
    },
    deepseek: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
    ark: {
      provider: 'openai-compatible',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: '',
      modelPlaceholder: '填入推理接入点 ID (ep-...) 或模型名',
    },
    ollama: {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
    },
  };

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    config: null,
    poll: null,
    suggestions: [],
    activeIndex: 0,
    workspaceNames: [],
    drawerOpen: false,
    drawerAutoOpened: false,
    predictingLocal: false,
    lastRequestedTurnKey: '',
    sentForTurnKey: '',
    failedCooldown: new Map(), // turnKey -> timestamp
    pollTimer: null,
  };

  function currentConvId() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  function apiFetch(url, options = {}) {
    if (window.sidecar?.fetch) {
      return window.sidecar.fetch(url, options);
    }
    const headers = new Headers(options.headers || {});
    if (options.method && options.method !== 'GET' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...options, headers });
  }

  async function apiJson(url, options = {}) {
    const res = await apiFetch(url, options);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || `HTTP ${res.status}` };
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ---------- theme sync (mirrors swarm_board/app.js) ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(() => syncScheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- workspace tracking ----------
  function extractWorkspaceNames(uris) {
    if (!Array.isArray(uris)) return [];
    const names = [];
    for (const raw of uris) {
      const cleaned = String(raw || '').replace(/\/+$/, '');
      if (!cleaned) continue;
      const seg = cleaned.split('/').pop();
      if (seg) {
        try {
          names.push(decodeURIComponent(seg));
        } catch {
          names.push(seg);
        }
      }
    }
    return [...new Set(names)];
  }

  if (window.sidecar?.getWorkspaceUris) {
    window.sidecar.getWorkspaceUris()
      .then((uris) => { state.workspaceNames = extractWorkspaceNames(uris); })
      .catch(() => {});
  }
  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      state.workspaceNames = extractWorkspaceNames(uris);
    });
  }

  // ---------- UI helpers ----------
  function setDrawerOpen(open) {
    state.drawerOpen = Boolean(open);
    $('settings-drawer').classList.toggle('hidden', !state.drawerOpen);
    $('btn-settings').classList.toggle('active', state.drawerOpen);
    $('btn-settings').setAttribute('aria-expanded', String(state.drawerOpen));
  }

  function showSettingsFeedback(message, isError = false) {
    const el = $('settings-feedback');
    if (!message) {
      el.className = 'feedback hidden';
      el.textContent = '';
      return;
    }
    el.className = `feedback ${isError ? 'err' : 'ok'}`;
    el.textContent = message;
  }

  function showErrorBanner(message) {
    const el = $('error-banner');
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    el.textContent = message;
  }

  function setSendStatus(message, isError = false) {
    const el = $('send-status');
    if (!message) {
      el.className = 'send-status hidden';
      el.textContent = '';
      return;
    }
    el.className = `send-status${isError ? ' err' : ''}`;
    el.textContent = message;
  }

  function endpointOrigin(rawUrl) {
    try {
      return new URL(String(rawUrl || '')).origin.toLowerCase();
    } catch {
      return '';
    }
  }

  function isLocalhostEndpoint(rawUrl) {
    try {
      const h = new URL(String(rawUrl || '')).hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch {
      return false;
    }
  }

  function updateKeyPlaceholder() {
    const cfg = state.config;
    const provider = $('cfg-provider').value;
    const baseUrl = $('cfg-baseurl').value.trim();
    const isLocal = provider === 'openai-compatible' && isLocalhostEndpoint(baseUrl);
    if (isLocal) {
      $('cfg-apikey').placeholder = '本地服务可留空';
      return;
    }
    const sameEndpoint = Boolean(
      cfg?.hasApiKey &&
      cfg.provider === provider &&
      endpointOrigin(cfg.baseUrl) === endpointOrigin(baseUrl),
    );
    $('cfg-apikey').placeholder = sameEndpoint
      ? `已保存 (${cfg.apiKeyPreview})，留空保持不变`
      : (cfg?.hasApiKey ? '端点已变更，请重新输入 API Key' : '输入 API Key');
  }

  function populateSettingsForm(cfg) {
    state.config = cfg;
    $('cfg-provider').value = cfg.provider || 'openai-compatible';
    $('cfg-baseurl').value = cfg.baseUrl || '';
    $('cfg-model').value = cfg.model || '';
    $('cfg-apikey').value = '';
    $('cfg-instructions').value = cfg.customInstructions || '';
    $('cfg-autopredict').checked = Boolean(cfg.autoPredict);
    $('cfg-path').textContent = cfg.configPath ? `配置保存在: ${cfg.configPath}` : '';
    updateKeyPlaceholder();

    if (!cfg.configured && !state.drawerAutoOpened) {
      state.drawerAutoOpened = true;
      setDrawerOpen(true);
    }
  }

  function readFormPatch({ forTest = false } = {}) {
    const apiKeyInput = $('cfg-apikey').value.trim();
    const patch = {
      provider: $('cfg-provider').value,
      baseUrl: $('cfg-baseurl').value.trim(),
      model: $('cfg-model').value.trim(),
      customInstructions: $('cfg-instructions').value.trim(),
      autoPredict: $('cfg-autopredict').checked,
    };
    if (apiKeyInput) {
      patch.apiKey = apiKeyInput;
    } else if (forTest) {
      patch.keepExistingKey = true;
    }
    return patch;
  }

  function activeGhostSuggestion() {
    if (!state.suggestions.length) return null;
    const idx = Math.max(0, Math.min(state.activeIndex, state.suggestions.length - 1));
    return state.suggestions[idx] || null;
  }

  function syncComposerGhostAndHeight() {
    const input = $('composer-input');
    const overlay = $('ghost-overlay');
    const active = activeGhostSuggestion();

    if (input.value === '' && active?.text) {
      overlay.textContent = active.text;
      input.placeholder = '';
    } else {
      overlay.textContent = '';
      input.placeholder = '输入消息，或按 Tab 采纳灰字预测 (Enter 发送)';
    }

    input.style.height = 'auto';
    const targetHeight = Math.min(132, Math.max(52, input.scrollHeight, overlay.scrollHeight));
    input.style.height = `${targetHeight}px`;
  }

  function renderStatus() {
    const pill = $('status-pill');
    const label = $('status-text');
    const latency = $('latency-badge');
    const subMeta = $('sub-meta');
    const btnRefresh = $('btn-refresh');

    const poll = state.poll;
    const predicting = Boolean(state.predictingLocal || poll?.predicting);
    btnRefresh.disabled = predicting || !state.config?.configured;

    if (state.config && !state.config.configured) {
      pill.dataset.state = 'setup';
      label.textContent = 'Setup required';
    } else if (predicting) {
      pill.dataset.state = 'predicting';
      label.textContent = 'Predicting…';
    } else if (poll?.status === 'working') {
      pill.dataset.state = 'working';
      label.textContent = 'Agent working…';
    } else if (poll?.turnEnded) {
      pill.dataset.state = 'ready';
      label.textContent = 'Ready';
    } else {
      pill.dataset.state = 'idle';
      label.textContent = 'Waiting';
    }

    const ms = poll?.prediction?.latencyMs;
    if (Number.isFinite(ms)) {
      latency.textContent = `${ms}ms`;
      latency.classList.remove('hidden');
    } else {
      latency.textContent = '';
      latency.classList.add('hidden');
    }

    if (poll?.lastReplyPreview) {
      subMeta.textContent = `上一轮回复: ${poll.lastReplyPreview}`;
      subMeta.classList.remove('hidden');
    } else if (!currentConvId()) {
      subMeta.textContent = '未检测到当前对话 ID（请在会话侧栏中打开）';
      subMeta.classList.remove('hidden');
    } else {
      subMeta.textContent = '';
      subMeta.classList.add('hidden');
    }
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  }

  async function sendPromptToConversation(text, triggerBtn = null) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const convId = currentConvId();

    if (!window.sidecar?.agent?.sendMessage) {
      setSendStatus('当前不在 Antigravity 宿主中，请使用复制', true);
      return false;
    }
    if (!convId) {
      setSendStatus('未找到当前对话 ID', true);
      return false;
    }

    if (triggerBtn) triggerBtn.disabled = true;
    $('btn-send-composer').disabled = true;
    setSendStatus('发送中…');

    try {
      await window.sidecar.agent.sendMessage(trimmed, convId);
      if (state.poll?.turnKey) {
        state.sentForTurnKey = state.poll.turnKey;
      }
      setSendStatus('已发送');
      setTimeout(() => setSendStatus(''), 2000);
      return true;
    } catch (err) {
      setSendStatus(`发送失败: ${err.message}`, true);
      return false;
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
      $('btn-send-composer').disabled = false;
    }
  }

  function renderSuggestions() {
    const list = $('suggestions-list');
    const empty = $('empty-state');
    const emptyTitle = $('empty-title');
    const emptyDesc = $('empty-desc');

    list.innerHTML = '';

    if (state.suggestions.length === 0) {
      empty.classList.remove('hidden');
      if (state.config && !state.config.configured) {
        emptyTitle.textContent = '请先配置模型 API Key';
        emptyDesc.textContent = '点击右上角设置或直接在上方表单填写 Key 并保存。';
      } else if (state.predictingLocal || state.poll?.predicting) {
        emptyTitle.textContent = '正在生成预测…';
        emptyDesc.textContent = '正在分析最新对话上下文。';
      } else if (state.poll?.status === 'working') {
        emptyTitle.textContent = 'AI 正在思考或执行工具';
        emptyDesc.textContent = '本轮回复完成后将处理下一步预测。';
      } else if (state.poll?.turnEnded && state.config?.configured && !state.config?.autoPredict) {
        emptyTitle.textContent = '自动预测已关闭';
        emptyDesc.textContent = '点击右上角 ↻ 手动生成预测，或在设置中开启自动预测（会发送最近对话至 Base URL）。';
      } else {
        emptyTitle.textContent = '等待对话轮次结束';
        emptyDesc.textContent = '对话完成一轮回复后，可自动或手动生成 1~3 条预测提示词。';
      }
      syncComposerGhostAndHeight();
      return;
    }

    empty.classList.add('hidden');

    if (state.activeIndex >= state.suggestions.length) {
      state.activeIndex = 0;
    }

    state.suggestions.forEach((item, idx) => {
      const card = document.createElement('article');
      card.className = `suggestion-card${idx === 0 ? ' recommended' : ''}${idx === state.activeIndex ? ' active' : ''}`;
      card.tabIndex = 0;

      const top = document.createElement('div');
      top.className = 'card-top';

      const badges = document.createElement('div');
      badges.className = 'card-badges';

      if (idx === 0) {
        const recBadge = document.createElement('span');
        recBadge.className = 'rec-badge';
        recBadge.textContent = '★ 最推荐';
        badges.appendChild(recBadge);
      }

      const tag = document.createElement('span');
      tag.className = 'tag-badge';
      tag.textContent = item.label || `建议 ${idx + 1}`;
      badges.appendChild(tag);

      if (idx === state.activeIndex) {
        const tabBadge = document.createElement('span');
        tabBadge.className = 'tab-badge';
        tabBadge.textContent = 'Tab';
        badges.appendChild(tabBadge);
      }

      const actions = document.createElement('div');
      actions.className = 'card-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'card-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(item.text, copyBtn);
      });

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'card-btn send';
      sendBtn.textContent = '发送';
      sendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendPromptToConversation(item.text, sendBtn);
      });

      actions.append(copyBtn, sendBtn);
      top.append(badges, actions);

      const textEl = document.createElement('p');
      textEl.className = 'card-text';
      textEl.textContent = item.text;

      card.addEventListener('click', () => {
        state.activeIndex = idx;
        const input = $('composer-input');
        input.value = item.text;
        input.focus();
        input.setSelectionRange(item.text.length, item.text.length);
        renderSuggestions();
      });

      card.append(top, textEl);
      list.appendChild(card);
    });

    syncComposerGhostAndHeight();
  }

  async function requestPredictions({ force = false } = {}) {
    const convId = currentConvId();
    if (!convId || state.predictingLocal) return;

    state.predictingLocal = true;
    const turnKeyAtRequest = state.poll?.turnKey || '';
    if (!force && turnKeyAtRequest) {
      state.lastRequestedTurnKey = turnKeyAtRequest;
    }
    showErrorBanner('');
    renderStatus();
    renderSuggestions();

    try {
      const result = await apiJson('/api/predict', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: convId,
          force,
          workspaceNames: state.workspaceNames,
        }),
      });
      if (!result.skipped && Array.isArray(result.suggestions)) {
        state.suggestions = result.suggestions;
        state.activeIndex = 0;
        if (state.poll) {
          state.poll.prediction = result;
          state.poll.cached = true;
        }
        if (result.turnKey) {
          state.failedCooldown.delete(result.turnKey);
        }
      }
    } catch (err) {
      if (turnKeyAtRequest) {
        state.failedCooldown.set(turnKeyAtRequest, Date.now());
      }
      showErrorBanner(`预测请求失败: ${err.message}`);
    } finally {
      state.predictingLocal = false;
      renderStatus();
      renderSuggestions();
    }
  }

  async function pollOnce() {
    if (document.hidden) return;
    const convId = currentConvId();
    try {
      const data = await apiJson('/api/state', {
        method: 'POST',
        body: JSON.stringify({ conversationId: convId }),
      });
      state.poll = data;

      if (data.prediction && Array.isArray(data.prediction.suggestions)) {
        const prevKey = state.suggestions.map((s) => s.text).join('\n');
        const nextKey = data.prediction.suggestions.map((s) => s.text).join('\n');
        if (prevKey !== nextKey) {
          state.suggestions = data.prediction.suggestions;
          state.activeIndex = 0;
        }
      } else if (!data.turnEnded && data.status === 'empty') {
        state.suggestions = [];
      }

      if (data.turnKey && state.sentForTurnKey && data.turnKey !== state.sentForTurnKey) {
        state.sentForTurnKey = '';
      }

      renderStatus();
      renderSuggestions();

      const cooledDown = !data.turnKey ||
        !state.failedCooldown.has(data.turnKey) ||
        Date.now() - state.failedCooldown.get(data.turnKey) > ERROR_COOLDOWN_MS;

      if (
        data.turnEnded &&
        data.configured &&
        data.autoPredict &&
        !data.cached &&
        !data.predicting &&
        !state.predictingLocal &&
        data.turnKey &&
        data.turnKey !== state.lastRequestedTurnKey &&
        data.turnKey !== state.sentForTurnKey &&
        cooledDown
      ) {
        requestPredictions({ force: false });
      }
    } catch (err) {
      showErrorBanner(`状态轮询失败: ${err.message}`);
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollOnce, POLL_MS);
  }

  // ---------- Event wiring ----------
  $('btn-settings').addEventListener('click', () => {
    setDrawerOpen(!state.drawerOpen);
  });

  $('btn-close-settings').addEventListener('click', () => {
    setDrawerOpen(false);
  });

  $('btn-refresh').addEventListener('click', () => {
    requestPredictions({ force: true });
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      $('cfg-provider').value = preset.provider;
      $('cfg-baseurl').value = preset.baseUrl;
      $('cfg-model').value = preset.model;
      $('cfg-model').placeholder = preset.modelPlaceholder || '模型名';
      updateKeyPlaceholder();
      showSettingsFeedback('');
      if (!preset.model) {
        $('cfg-model').focus();
      } else if (!$('cfg-apikey').value && !state.config?.hasApiKey) {
        $('cfg-apikey').focus();
      }
    });
  });

  $('btn-test').addEventListener('click', async () => {
    const btn = $('btn-test');
    btn.disabled = true;
    showSettingsFeedback('正在测试连通性…');
    try {
      const res = await apiJson('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify(readFormPatch({ forTest: true })),
      });
      if (res.ok) {
        showSettingsFeedback(`连接成功 (${res.model}, ${res.latencyMs}ms)`);
      } else {
        showSettingsFeedback(res.error || '连接失败', true);
      }
    } catch (err) {
      showSettingsFeedback(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-save');
    btn.disabled = true;
    showSettingsFeedback('正在保存…');
    try {
      const saved = await apiJson('/api/config', {
        method: 'POST',
        body: JSON.stringify(readFormPatch()),
      });
      populateSettingsForm(saved);
      state.lastRequestedTurnKey = '';
      state.failedCooldown.clear();
      showSettingsFeedback('已保存');
      showErrorBanner('');
      setTimeout(() => {
        if (saved.configured) setDrawerOpen(false);
      }, 600);
      pollOnce();
    } catch (err) {
      showSettingsFeedback(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-clear-key').addEventListener('click', async () => {
    const btn = $('btn-clear-key');
    btn.disabled = true;
    try {
      const saved = await apiJson('/api/config', {
        method: 'POST',
        body: JSON.stringify({ clearApiKey: true }),
      });
      populateSettingsForm(saved);
      showSettingsFeedback('已清除保存的 API Key');
      renderStatus();
      renderSuggestions();
    } catch (err) {
      showSettingsFeedback(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  const composer = $('composer-input');
  composer.addEventListener('input', () => {
    syncComposerGhostAndHeight();
  });

  composer.addEventListener('keydown', async (e) => {
    if (e.isComposing || e.keyCode === 229) return;

    if (
      e.key === 'Tab' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      composer.value === ''
    ) {
      const ghost = activeGhostSuggestion();
      if (ghost?.text) {
        e.preventDefault();
        composer.value = ghost.text;
        composer.setSelectionRange(ghost.text.length, ghost.text.length);
        syncComposerGhostAndHeight();
      }
      return;
    }

    if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      composer.value === '' &&
      state.suggestions.length > 1
    ) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      state.activeIndex = (state.activeIndex + delta + state.suggestions.length) % state.suggestions.length;
      renderSuggestions();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const text = composer.value.trim();
      if (!text) return;
      const ok = await sendPromptToConversation(text);
      if (ok) {
        composer.value = '';
        syncComposerGhostAndHeight();
      }
    }
  });

  $('btn-send-composer').addEventListener('click', async () => {
    const text = composer.value.trim() || activeGhostSuggestion()?.text || '';
    if (!text) return;
    const ok = await sendPromptToConversation(text);
    if (ok && composer.value.trim()) {
      composer.value = '';
      syncComposerGhostAndHeight();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pollOnce();
    }
  });

  $('cfg-provider').addEventListener('change', updateKeyPlaceholder);
  $('cfg-baseurl').addEventListener('input', updateKeyPlaceholder);

  async function init() {
    try {
      const cfg = await apiJson('/api/config/get', { method: 'POST', body: '{}' });
      populateSettingsForm(cfg);
    } catch (err) {
      showErrorBanner(`读取配置失败: ${err.message}`);
    }
    renderStatus();
    renderSuggestions();
    await pollOnce();
    startPolling();
  }

  init();
})();
