// QA T-07: a message is pending until a step starts, and refused if the job settles first.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../../src/hub/index.mjs';

const token = 'qa-ledger-token-'.repeat(2);

test('pending → delivered on the next step', async () => {
  const events = new Map();
  let finishIdle;
  let idleCalls = 0;
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on(n, f) { events.set(n, f); }, tools: { register() {} } });
        return {
          agent: {
            session: {}, model: { select() {} }, steer() {},
            async whenIdle() { idleCalls += 1; if (idleCalls > 1) await new Promise((r) => { finishIdle = r; }); },
            followup() {},
          },
          async dispose() {},
        };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const job = await registry.spawn({ task: 'x', cwd: '/fixture', messaging_token: token, timeout_seconds: 30 });
  await registry.message(job.id, token, 'steer');
  assert.deepEqual(job.messages, { delivered: 0, pending: 1, refused: 0 });
  events.get('session/event')({}, { type: 'step/start', data: { step: 2, turn: 1 } });
  assert.deepEqual(job.messages, { delivered: 1, pending: 0, refused: 0 });
  events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  finishIdle?.();
  await job.promise;
});
