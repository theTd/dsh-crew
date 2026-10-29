// The `crew_job` block and footer (src/crew-block.mjs).
//
// This is the only part of the tool output a shell parses, so every field a
// dispatcher might branch on must be present, even when null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crewBlock, crewFooter, elapsedSeconds, waitCommand, withCrewBlock, WAIT_JOB_PATH } from '../src/crew-block.mjs';

const job = {
  id: 'hub-1-abc', sessionId: 'session-1', status: 'done', model: 'deepseek-flash',
  step: 3, toolCalls: 4, currentTool: null, tokens: { input: 1200, output: 34 },
  startedAt: '2026-10-29T00:00:00.000Z', endedAt: '2026-10-29T00:00:09.000Z',
};

test('the block is complete and stable', () => {
  const block = crewBlock(job);
  assert.equal(block.crew, 'dsh');
  assert.equal(block.job_id, 'hub-1-abc');
  assert.equal(block.status, 'done');
  assert.equal(block.session_ref, 'session-1');
  assert.deepEqual(block.tokens, { in: 1200, out: 34 });
  assert.equal(block.elapsed_s, 9);
  assert.deepEqual(block.messages, { delivered: 0, pending: 0, refused: 0 });
  assert.equal(block.continued_from, null);
  assert.equal(block.lease_expires_at, null);
  assert.equal(block.log_path, null);
  assert.equal(block.wait_command, `node "${WAIT_JOB_PATH}" hub-1-abc`);
  assert.match(waitCommand('x'), /wait-job\.mjs" x$/);
});

test('the wait command carries a message cursor only when one is needed', () => {
  assert.equal(waitCommand('hub-1-abc', 7), `node "${WAIT_JOB_PATH}" hub-1-abc --after 7`);
  assert.equal(waitCommand('hub-1-abc', 0), `node "${WAIT_JOB_PATH}" hub-1-abc`);
  assert.equal(waitCommand('hub-1-abc', -1), `node "${WAIT_JOB_PATH}" hub-1-abc`);
  assert.equal(crewBlock(job, { after: 12 }).wait_command, `node "${WAIT_JOB_PATH}" hub-1-abc --after 12`);
  assert.equal(crewBlock(job).wait_command, `node "${WAIT_JOB_PATH}" hub-1-abc`);
});

test('a null session and missing counters do not crash the block', () => {
  const block = crewBlock({ id: 'local-1', status: 'running' });
  assert.equal(block.session_ref, null);
  assert.equal(block.step, 0);
  assert.equal(block.tool_calls, 0);
  assert.deepEqual(block.tokens, { in: 0, out: 0 });
  assert.equal(block.elapsed_s, 0);
});

test('the footer names the undelivered count only when there is one', () => {
  const plain = crewFooter(crewBlock(job));
  assert.match(plain, /^\[dsh \| job hub-1-abc \| done \| deepseek-flash \| tokens 1200\/34 \| tool calls 4 \| 9s \| msgs 0\]$/);
  const withRefused = crewFooter(crewBlock(job, { messages: { delivered: 1, pending: 0, refused: 2 } }));
  assert.match(withRefused, /msgs 1 \(2 undelivered\)/);
});

test('a tool body gains exactly one footer and one machine line', () => {
  const out = withCrewBlock('spawned', job, { logPath: '/logs/hub-1-abc.log' });
  const lines = out.split('\n');
  assert.equal(lines[0], 'spawned');
  assert.match(lines.at(-2), /^\[dsh \|/);
  assert.match(lines.at(-1), /^crew_job: \{/);
  assert.match(lines.at(-1), /"log_path":"\/logs\/hub-1-abc\.log"/);
});

test('elapsed time stops at endedAt and never goes negative', () => {
  assert.equal(elapsedSeconds({ startedAt: '2026-10-29T00:00:00Z', endedAt: '2026-10-29T00:00:05Z' }, Date.parse('2026-10-29T01:00:00Z')), 5);
  assert.equal(elapsedSeconds({ startedAt: '2026-10-29T00:00:05Z', endedAt: '2026-10-29T00:00:00Z' }), 0);
  assert.equal(elapsedSeconds({}), 0);
});
