// Standalone dispatch on dsh 0.2.2 (ADR 0002): one fixed sentence, no side
// effects.
//
// The old path launched an SDK runtime that no longer exists. A caller without a
// running DSH instance must be told to switch to hub mode (or a CLI backend), not
// handed an ERR_MODULE_NOT_FOUND from deep inside startup — and nothing may be
// locked or registered on the way to that error.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startJob, listJobs } from '../src/jobs.mjs';
import { getCwdLocks } from '../src/cwd-lock.mjs';

test('standalone dispatch refuses before touching a lock or the registry', async () => {
  const before = listJobs().length;
  await assert.rejects(
    () => startJob({ task: 'fixture', cwd: '/fixture' }),
    { message: 'dsh-crew: standalone dispatch is not supported on dsh 0.2.2; start a DSH instance and use hub mode, or dispatch with worker="<profile>" for a CLI backend' },
  );
  assert.equal(listJobs().length, before);
  assert.equal(getCwdLocks().some((lock) => lock.cwd === '/fixture'), false);
});
