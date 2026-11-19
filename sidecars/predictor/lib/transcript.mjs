import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Locate Antigravity appData directories containing `brain/`.
 * Mirrors `swarm_board/main.mjs` with an env override for tests.
 */
export function findAppDataDirs(env = process.env, home = homedir()) {
  const override = env?.PREDICTOR_APP_DATA_DIR;
  if (typeof override === 'string' && override.trim()) {
    return [override.trim()];
  }

  const dataDir = env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }

  const root = join(home, '.gemini');
  const dirs = safeReaddir(root).sort().map((name) => join(root, name));
  return dirs.filter((c) => existsSync(join(c, 'brain')));
}

/** Resolve the transcript.jsonl path for a validated conversation ID. */
export function resolveTranscriptPath(convId, appDataDirs = findAppDataDirs()) {
  if (typeof convId !== 'string' || !ID_RE.test(convId)) return null;
  for (const appData of appDataDirs) {
    const candidate = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extract clean user prompt text from Antigravity USER_INPUT step content. */
export function extractUserRequest(rawContent) {
  if (typeof rawContent !== 'string') return '';
  const match = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match) {
    return match[1].trim();
  }
  return rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

/** Truncate long text by keeping ~40% head and ~60% tail around an ellipsis marker. */
export function truncateMiddle(text, maxChars) {
  const s = typeof text === 'string' ? text : String(text || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (s.length <= maxChars) return s;
  if (maxChars <= 3) return s.slice(0, maxChars);

  const marker = '\n…\n';
  const available = maxChars - marker.length;
  if (available <= 2) {
    return s.slice(0, maxChars - 1) + '…';
  }
  const headLen = Math.floor(available * 0.4);
  const tailLen = available - headLen;
  const head = headLen > 0 ? s.slice(0, headLen).trimEnd() : '';
  const tail = tailLen > 0 ? s.slice(s.length - tailLen).trimStart() : '';
  if (!head) return tail.slice(0, maxChars);
  if (!tail) return head.slice(0, maxChars);
  return `${head}${marker}${tail}`;
}

function oneLinePreview(text, maxLen = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * Parse compact transcript JSONL and determine whether the current turn has completed.
 */
export function parseTranscriptState(jsonlText) {
  const rawLines = String(jsonlText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (rawLines.length === 0) {
    return {
      status: 'empty',
      turnEnded: false,
      lastStepIndex: -1,
      turnKey: '',
      messageCount: 0,
      messages: [],
      lastReplyPreview: '',
    };
  }

  const validSteps = [];
  let tornLastLine = false;
  for (let i = 0; i < rawLines.length; i++) {
    try {
      const parsed = JSON.parse(rawLines[i]);
      if (parsed && typeof parsed === 'object') {
        validSteps.push(parsed);
      } else if (i === rawLines.length - 1) {
        tornLastLine = true;
      }
    } catch {
      if (i === rawLines.length - 1) {
        tornLastLine = true;
      }
    }
  }

  if (validSteps.length === 0) {
    return {
      status: tornLastLine ? 'working' : 'empty',
      turnEnded: false,
      lastStepIndex: -1,
      turnKey: '',
      messageCount: 0,
      messages: [],
      lastReplyPreview: '',
    };
  }

  const lastStep = validSteps[validSteps.length - 1];
  const lastStepIndex = Number.isFinite(lastStep.step_index)
    ? lastStep.step_index
    : validSteps.length - 1;

  const hasToolCalls = Array.isArray(lastStep.tool_calls) && lastStep.tool_calls.length > 0;
  const turnEnded = Boolean(
    !tornLastLine &&
    lastStep.type === 'PLANNER_RESPONSE' &&
    lastStep.status === 'DONE' &&
    !hasToolCalls &&
    typeof lastStep.content === 'string' &&
    lastStep.content.trim().length > 0
  );

  const status = turnEnded ? 'ready' : 'working';

  const allMessages = [];
  for (const step of validSteps) {
    if (step.type === 'USER_INPUT') {
      const text = extractUserRequest(step.content);
      if (text) {
        allMessages.push({ role: 'user', text });
      }
    } else if (
      step.type === 'PLANNER_RESPONSE' &&
      step.status === 'DONE' &&
      (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0) &&
      typeof step.content === 'string' &&
      step.content.trim().length > 0
    ) {
      allMessages.push({ role: 'assistant', text: step.content.trim() });
    }
  }

  const recent = allMessages.slice(-6);
  let lastUserIdx = -1;
  let lastAssistantIdx = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].role === 'user') lastUserIdx = i;
    if (recent[i].role === 'assistant') lastAssistantIdx = i;
  }

  const messages = recent.map((m, idx) => {
    let limit = 500;
    if (idx === lastAssistantIdx) limit = 2000;
    else if (idx === lastUserIdx) limit = 800;
    return {
      role: m.role,
      text: truncateMiddle(m.text, limit),
    };
  });

  const lastAssistant = lastAssistantIdx >= 0 ? recent[lastAssistantIdx] : null;
  const turnKey = turnEnded ? String(lastStep.step_index ?? validSteps.length) : '';

  return {
    status,
    turnEnded,
    lastStepIndex,
    turnKey,
    messageCount: allMessages.length,
    messages,
    lastReplyPreview: lastAssistant ? oneLinePreview(lastAssistant.text) : '',
  };
}
