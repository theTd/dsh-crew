// Hub-side job timeout (src/hub/index.mjs).
//
// Before this, only the blocking call had a bound: a spawned hub job could run
// forever, and no tool could stop it except cancel. The contract is a settled
// record with status "timeout" and one fixed sentence, not a hung "running".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

test('a hub job settles as timeout when its bound is reached', async () => {
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
          // Never idle: the job is stuck inside the first step, which is exactly
          // the shape a timeout has to rescue.
          whenIdle: () => new Promise(() => {}),
          followup() {},
        };
        return { agent, async dispose() { disposed = true; } };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({ task: 'fixture', cwd: '/fixture', timeout_seconds: 1 });
  await new Promise((done) => setTimeout(done, 1400));
  assert.equal(job.status, 'timeout');
  assert.equal(job.error, 'timed out after 1s');
  assert.equal(disposed, true, 'the timed-out session must be disposed');
  assert.equal(registry.view(job).status, 'timeout');
  assert.ok(job.endedAt, 'a timed-out job must be settled, not left half-finished');
  assert.deepEqual(job.messages, { delivered: 0, pending: 0, refused: 0 });
});

test('a job that finishes before its bound keeps its own status', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        let onEvent;
        await options.setup({ on(name, fn) { if (name === 'session/event') onEvent = fn; }, tools: { register() {} } });
        const agent = {
          session: {},
          model: { select() {} },
          async whenIdle() {},
          followup() {
            onEvent({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
            onEvent({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
        };
        return { agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({ task: 'fixture', cwd: '/fixture', timeout_seconds: 5 });
  await job.promise;
  assert.equal(job.status, 'done');
  assert.notEqual(job.error, 'timed out after 5s');
});
