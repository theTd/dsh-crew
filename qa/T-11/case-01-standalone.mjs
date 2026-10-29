// QA T-11: standalone dispatch refuses with one fixed sentence and no side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startJob, listJobs } from '../../src/jobs.mjs';
import { getCwdLocks } from '../../src/cwd-lock.mjs';

test('the refusal is fixed and leaves no lock or registry entry', async () => {
  const before = listJobs().length;
  await assert.rejects(() => startJob({ task: 'x', cwd: '/qa-standalone-fixture' }), {
    message: 'dsh-crew: standalone dispatch is not supported on dsh 0.2.2; start a DSH instance and use hub mode, or dispatch with worker="<profile>" for a CLI backend',
  });
  assert.equal(listJobs().length, before);
  assert.equal(getCwdLocks().some((lock) => lock.cwd === '/qa-standalone-fixture'), false);
});
