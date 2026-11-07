// Message ledger (src/hub/index.mjs): accepted → pending, next step → delivered,
// settle first → refused.
//
// "delivery: next_step" is a claim about what the runtime will do, not proof the
// model saw the text. The ledger removes that lie: a text sits in pending until
// the agent actually starts another step, and a job that settles first moves
// every pending text to refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

const token = 'ledger-token-'.repeat(3);

function fixture() {
  const events = new Map();
  let startedResolve;
  let finishIdle;
  let idleCalls = 0;
  const started = new Promise((resolve) => { startedResolve = resolve; });
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
          // First idle (before the prompt) resolves; the second one is the run
          // itself and only settle() releases it.
          async whenIdle() {
            idleCalls += 1;
            if (idleCalls <= 1) return;
            await new Promise((resolve) => { finishIdle = resolve; });
          },
          followup() { startedResolve(); },
          steer() {},
        };
        return { agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  return {
    registry,
    events,
    started,
    settle() {
      events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
      finishIdle?.();
    },
  };
}

test('an accepted message stays pending until the next step starts', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', messaging_token: token, timeout_seconds: 30 });
  await f.started;
  const accepted = await f.registry.message(job.id, token, 'Focus on the parser.');
  assert.equal(accepted.delivery, 'next_step');
  assert.deepEqual(job.messages, { delivered: 0, pending: 1, refused: 0 });

  // The next step starting is the only proof the text reached the model.
  f.events.get('session/event')({}, { type: 'step/start', data: { step: 2, turn: 1 } });
  assert.deepEqual(job.messages, { delivered: 1, pending: 0, refused: 0 });
  assert.equal(job._pendingMessages, 0);

  f.settle();
  await job.promise;
  assert.deepEqual(job.messages, { delivered: 1, pending: 0, refused: 0 });
});

test('a message accepted before settle is refused, not silently dropped', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', messaging_token: token, timeout_seconds: 30 });
  await f.started;
  await f.registry.message(job.id, token, 'never reaches a step');
  assert.equal(job.messages.pending, 1);
  f.settle();
  await job.promise;
  assert.deepEqual(job.messages, { delivered: 0, pending: 0, refused: 1 });
  assert.match(job.log.tail(20).map((e) => e.summary).join('\n'), /refused 1 message\(s\): job settled before the next step/);
});

test('a reply to a waiting tool counts as delivered at once', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', messaging_token: token, timeout_seconds: 30 });
  await f.started;
  const waiting = job.mailbox.request('Which parser?', 5);
  const { messages } = await f.registry.messages(job.id, token, 0, 0);
  const request = messages[0];
  await f.registry.message(job.id, token, 'The existing one.', request.message_id);
  assert.equal((await waiting).reply, 'The existing one.');
  assert.deepEqual(job.messages, { delivered: 1, pending: 0, refused: 0 });
});
