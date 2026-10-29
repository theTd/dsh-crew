// Opt-in lease (src/hub/index.mjs): a dispatcher that stops polling must not
// leave a worker running, but a job without a lease is never auto-cancelled.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

function fixture({ settle = false } = {}) {
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
        const agent = {
          session: {},
          model: { select() {} },
          async whenIdle() { if (!settle) await new Promise(() => {}); },
          followup() {},
        };
        return { agent, async dispose() { disposed = true; } };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  return { registry, wasDisposed: () => disposed };
}

test('an expired lease cancels the running job with the fixed sentence', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', lease_seconds: 60, timeout_seconds: 120 });
  await new Promise((done) => setImmediate(done)); // let run() attach the handle
  assert.ok(job.lease.expiresAt > Date.now());
  job.lease.expiresAt = Date.now() - 1;
  f.registry.sweepLeases();
  assert.equal(job.status, 'cancelled');
  assert.equal(job.error, 'cancelled: dispatcher stopped polling (lease expired)');
  assert.equal(f.wasDisposed(), true);
  assert.match(job.log.tail(20).map((e) => e.summary).join('\n'), /lease expired/);
});

test('a live lease survives a sweep, and renewLease pushes the deadline out', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', lease_seconds: 60, timeout_seconds: 120 });
  f.registry.sweepLeases();
  assert.equal(job.status, 'running');
  const before = job.lease.expiresAt;
  f.registry.renewLease(job);
  assert.ok(job.lease.expiresAt >= before);
});

test('a job without a lease is never swept', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', timeout_seconds: 120 });
  assert.equal(job.lease, undefined);
  f.registry.sweepLeases(Date.now() + 10 * 60_000);
  assert.equal(job.status, 'running');
});

test('an out-of-range lease is refused before anything is registered', async () => {
  const f = fixture({ settle: true });
  await assert.rejects(f.registry.spawn({ task: 'fixture', cwd: '/fixture', lease_seconds: 10 }), /60 to 3600/);
  assert.equal(f.registry.jobs.size, 0);
});
