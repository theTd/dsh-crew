// QA T-05: the per-job log is a real file, readable by another process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'qa-job-log-'));
process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
const { JobLog, readJobLog, MAX_SUMMARY } = await import('../../src/job-log.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('events land on disk and come back bounded and clipped', () => {
  const log = new JobLog('qa-1');
  log.record('tool_call', 'Bash: npm test');
  log.record('text', 'z'.repeat(MAX_SUMMARY + 20));
  const read = readJobLog('qa-1', 10);
  assert.equal(read.found, true);
  assert.equal(read.events.length, 2);
  assert.equal(read.events[0].kind, 'tool_call');
  assert.match(read.events[1].summary, /…$/);
  assert.match(readFileSync(join(root, 'logs', 'qa-1.log'), 'utf8'), /"tool_call"/);
  assert.equal(JSON.parse(readFileSync(join(root, 'logs', 'qa-1.log'), 'utf8').trim().split('\n')[0]).kind, 'tool_call');
});
