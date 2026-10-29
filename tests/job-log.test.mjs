// Per-job event log (src/job-log.mjs).
//
// The log is what a failed worker leaves behind, so the contract is small and
// load-bearing: a bounded ring in memory, one JSONL line per event on disk, and
// a reader that never throws on a half-written line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'crew-job-log-'));
process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
const { JobLog, MAX_EVENTS, MAX_SUMMARY, clip, readJobLog, logPathFor } = await import('../src/job-log.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

test('events are clipped, ringed and written as JSONL', () => {
  const log = new JobLog('job-a');
  log.record('tool_call', 'Bash: npm test');
  assert.match(log.path, /logs[\\/]job-a\.log$/);
  const events = readJobLog('job-a', 10);
  assert.equal(events.found, true);
  assert.equal(events.events[0].kind, 'tool_call');
  assert.equal(events.events[0].summary, 'Bash: npm test');

  const long = new JobLog('job-b');
  long.record('text', 'x'.repeat(MAX_SUMMARY + 50));
  const clipped = readJobLog('job-b', 1).events[0];
  assert.equal(clipped.summary.length, MAX_SUMMARY + 1, 'one ellipsis marks the cut');
  assert.match(clipped.summary, /…$/);

  const ring = new JobLog('job-c');
  for (let i = 0; i < MAX_EVENTS + 5; i += 1) ring.record('step', `step ${i}`);
  assert.equal(ring.events.length, MAX_EVENTS);
  assert.equal(ring.events[0].summary, `step 5`);
  assert.equal(readFileSync(ring.path, 'utf8').trim().split('\n').length, MAX_EVENTS + 5);
});

test('an absent log is reported, not thrown', () => {
  const missing = readJobLog('never-ran', 5);
  assert.equal(missing.found, false);
  assert.equal(logPathFor('never-ran'), missing.path);
  assert.equal(clip('  many\n spaces\there  '), 'many spaces here');
});

test('a job id cannot escape the log folder', () => {
  for (const id of ['../../secret', '..\\..\\secret', 'a/b', 'a\\b', 'x'.repeat(200), '']) {
    assert.throws(() => logPathFor(id), /invalid job id/, `id ${JSON.stringify(id)} must be refused`);
    assert.throws(() => readJobLog(id), /invalid job id/);
  }
});
