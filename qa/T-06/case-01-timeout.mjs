// QA T-06: a hub job with a bound settles as timeout, not as a hung running job.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../../src/hub/index.mjs';

test('timeout settles the record and disposes the session', async () => {
  let disposed = false;
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on() {}, tools: { register() {} } });
        return { agent: { session: {}, model: { select() {} }, whenIdle: () => new Promise(() => {}), followup() {} }, async dispose() { disposed = true; } };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({ task: 'fixture', cwd: '/fixture', timeout_seconds: 1 });
  await new Promise((done) => setTimeout(done, 1400));
  assert.equal(job.status, 'timeout');
  assert.equal(job.error, 'timed out after 1s');
  assert.equal(disposed, true);
});
