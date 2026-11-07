// QA T-10: an expired opt-in lease cancels the job; a job without one never is.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../../src/hub/index.mjs';

function fixture() {
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on() {}, tools: { register() {} } });
        return { agent: { session: {}, model: { select() {} }, whenIdle: () => new Promise(() => {}), followup() {} }, async dispose() {} };
      },
    },
  };
  return new WorkerRegistry(ctx, { publish() {} });
}

test('lease expiry cancels, no lease means no sweep', async () => {
  const registry = fixture();
  const leased = await registry.spawn({ task: 'x', cwd: '/fixture', lease_seconds: 60, timeout_seconds: 120 });
  const plain = await registry.spawn({ task: 'y', cwd: '/fixture/', timeout_seconds: 120 });
  leased.lease.expiresAt = Date.now() - 1;
  registry.sweepLeases();
  assert.equal(leased.status, 'cancelled');
  assert.equal(leased.error, 'cancelled: dispatcher stopped polling (lease expired)');
  assert.equal(plain.status, 'running');
});
