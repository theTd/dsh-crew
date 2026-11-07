// A spawn that throws before the agent is created must not leave a zombie job.
//
// The hub registers a job so status and messaging can find it while it runs. If
// a later step of spawn() throws (an unknown preset id is the observed case),
// the registration used to survive with status 'running', no run(), no promise
// and no finalizer: GET /jobs listed a worker that would never finish, and a
// message awaiting job.started hung until the HTTP client timed out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

test('a preset that cannot resolve rejects the spawn and registers nothing', async () => {
  let created = 0;
  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return { async resolve() { const error = new Error('agent-preset/not-found'); error.code = 'agent-preset/not-found'; throw error; } };
      }
      return undefined;
    },
    sessions: { async flush() {} },
    agents: { async create() { created += 1; throw new Error('must not create an agent'); } },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  await assert.rejects(registry.spawn({ task: 'fixture', cwd: '/fixture', preset: 'missing' }), /agent-preset\/not-found/);
  assert.equal(registry.jobs.size, 0, 'a failed spawn must leave no job behind');
  assert.equal(created, 0, 'the agent must not be created when preset resolution fails');
});
