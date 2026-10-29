// Continue a settled job (src/hub/index.mjs continueJob).
//
// "Continue" means the same session: a fresh job id, the old session id,
// continued_from pointing back, and the answer coming from the same live agent.
// When the hub has restarted and the handle is gone, the persisted session is
// resumed instead. Both paths are exercised here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

function fixture({ keepRunning = false } = {}) {
  const events = new Map();
  const resumed = [];
  let firstTurns = 0;
  const emit = (text) => {
    events.get('session/event')({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  };
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on(name, fn) { events.set(name, fn); }, tools: { register() {} } });
        const agent = {
          session: {},
          model: { select() {} },
          whenIdle: keepRunning ? () => new Promise(() => {}) : async () => {},
          followup() { firstTurns += 1; emit(firstTurns === 1 ? 'first answer' : 'second answer'); },
        };
        return { agent, async dispose() {} };
      },
      async resume(options) {
        resumed.push(options.resumeSessionId);
        await options.setup({ on(name, fn) { events.set(name, fn); }, tools: { register() {} } });
        const agent = {
          session: {},
          model: { select() {} },
          async whenIdle() {},
          followup() { emit('cold answer'); },
        };
        return { agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  return { registry, resumed };
}

test('a live continuation reuses the same agent and records continued_from', async () => {
  const f = fixture();
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await first.promise;
  assert.equal(first.status, 'done');

  const second = await f.registry.continueJob(first.id, 'and then?');
  assert.equal(second.continued_from, first.id);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.status, 'running');
  await second.promise;
  assert.equal(second.status, 'done');
  assert.equal(second.result, 'second answer');
  assert.equal(f.resumed.length, 0, 'a live handle must be reused, not resumed');
  assert.equal(f.registry.view(second).continued_from, first.id);
});

test('a cold continuation resumes the persisted session id', async () => {
  const f = fixture();
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await first.promise;
  first.handle = undefined; // hub restarted: nothing live to reuse

  const second = await f.registry.continueJob(first.id, 'still there?');
  await second.promise;
  assert.equal(second.status, 'done');
  assert.equal(second.result, 'cold answer');
  assert.deepEqual(f.resumed, [first.sessionId]);
});

test('continuing a running job is refused with a steer hint', async () => {
  const f = fixture();
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await assert.rejects(f.registry.continueJob(first.id, 'again'), /worker is running: use dsh_worker_message/);
  await first.promise;
});

test('a cancelled job has no live handle left to reuse, so it resumes', async () => {
  const f = fixture({ keepRunning: true });
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await new Promise((done) => setImmediate(done));
  await f.registry.cancel(first.id);
  assert.equal(first.handle, undefined, 'cancel must drop the disposed handle');
  const second = await f.registry.continueJob(first.id, 'after cancel');
  await second.promise;
  assert.equal(second.result, 'cold answer');
  assert.deepEqual(f.resumed, [first.sessionId]);
});

test('a job already being continued cannot be claimed twice', async () => {
  const f = fixture();
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await first.promise;
  const second = f.registry.continueJob(first.id, 'one');
  await assert.rejects(f.registry.continueJob(first.id, 'two'), /worker is already being continued/);
  const job = await second;
  await job.promise;
});

test('a rejected follow-up does not leave the job permanently claimed', async () => {
  const f = fixture();
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await first.promise;
  await assert.rejects(f.registry.continueJob(first.id, 'x'.repeat(20_000)), /message/i);
  const second = await f.registry.continueJob(first.id, 'valid follow-up');
  await second.promise;
  assert.equal(second.status, 'done');
});
