import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ID_RE,
  extractUserRequest,
  findAppDataDirs,
  parseTranscriptState,
  resolveTranscriptPath,
  truncateMiddle,
} from '../lib/transcript.mjs';

test('extractUserRequest handles tagged and untagged user inputs', () => {
  const tagged = '<USER_REQUEST>\n那我额外配key\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTime: now\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nModel changed\n</USER_SETTINGS_CHANGE>';
  assert.equal(extractUserRequest(tagged), '那我额外配key');

  const untagged = 'Fix the test\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nfoo\n</USER_SETTINGS_CHANGE>';
  assert.equal(extractUserRequest(untagged), 'Fix the test');
});

test('truncateMiddle preserves head (~40%) and tail (~60%) within maxChars', () => {
  const head = 'HEAD_'.repeat(30);
  const middle = 'MID_'.repeat(100);
  const tail = 'TAIL_END_QUESTION?';
  const full = `${head}${middle}${tail}`;

  const truncated = truncateMiddle(full, 120);
  assert.ok(truncated.length <= 120);
  assert.ok(truncated.startsWith('HEAD_'));
  assert.ok(truncated.includes('\n…\n'));
  assert.ok(truncated.endsWith(tail));
});

test('parseTranscriptState identifies finished turns vs working states and torn lines', () => {
  assert.equal(parseTranscriptState('').status, 'empty');
  assert.equal(parseTranscriptState('').turnEnded, false);

  const doneTranscript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n你好\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file' }], content: '' }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'file contents' }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: '需要我继续帮你生成吗？' }),
  ].join('\n');

  const doneState = parseTranscriptState(doneTranscript);
  assert.equal(doneState.status, 'ready');
  assert.equal(doneState.turnEnded, true);
  assert.equal(doneState.turnKey, '3');
  assert.equal(doneState.messageCount, 2);
  assert.deepEqual(doneState.messages, [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '需要我继续帮你生成吗？' },
  ]);

  // Working: tool_calls present on latest PLANNER_RESPONSE
  const toolTranscript = [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n跑测试\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command' }], content: '' }),
  ].join('\n');
  const toolState = parseTranscriptState(toolTranscript);
  assert.equal(toolState.status, 'working');
  assert.equal(toolState.turnEnded, false);

  // Working: ends on GENERIC tool output
  const genericTranscript = `${toolTranscript}\n${JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'ok' })}`;
  assert.equal(parseTranscriptState(genericTranscript).turnEnded, false);

  // Working: ends on USER_INPUT
  const userWaitTranscript = JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'hi' });
  assert.equal(parseTranscriptState(userWaitTranscript).turnEnded, false);

  // Working: torn last JSON line after an otherwise complete step
  const tornTranscript = `${doneTranscript}\n{"step_index":4,"type":"USER_IN`;
  const tornState = parseTranscriptState(tornTranscript);
  assert.equal(tornState.status, 'working');
  assert.equal(tornState.turnEnded, false);
});

test('resolveTranscriptPath validates IDs and resolves from PREDICTOR_APP_DATA_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-tr-'));
  try {
    const convId = '00000000-0000-4000-8000-000000000001';
    const logDir = join(dir, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'transcript.jsonl');
    writeFileSync(logFile, '', 'utf-8');

    assert.equal(ID_RE.test(convId), true);
    assert.equal(ID_RE.test('../etc/passwd'), false);
    assert.deepEqual(findAppDataDirs({ PREDICTOR_APP_DATA_DIR: dir }, dir), [dir]);
    assert.equal(resolveTranscriptPath(convId, [dir]), logFile);
    assert.equal(resolveTranscriptPath('../bad-id', [dir]), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
