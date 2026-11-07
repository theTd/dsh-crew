import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

const token = 'test-owner-token-'.repeat(3);

function fixture() {
  const tools = new Map(), events = new Map(), steering = [];
  let finish, markStarted;
  let idle = Promise.resolve();
  const started = new Promise(resolve => { markStarted = resolve; });
  const agent = {
    session: {},
    model: { select() {} },
    async whenIdle() { await idle; },
    followup() { idle = new Promise(resolve => { finish = resolve; }); markStarted(); },
    steer(message) { steering.push(message); },
  };
  const handle = { agent, async dispose() { finish?.(); } };
  const ctx = {
    get() {}, sessions: { async flush() {} },
    agents: { async create(options) {
      await options.setup({ on(name, fn) { events.set(name, fn); },
        tools: { register(tool) { tools.set(tool.name, tool); } } });
      return handle;
    } },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  return { registry, tools, steering, started,
    finish() { events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); finish(); } };
}

test('running workers exchange messages and correlated replies without exposing owner tokens', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', messaging_token: token });
  await f.started;
  await f.registry.message(job.id, token, 'Focus on the parser.');
  assert.equal(f.steering[0].content[0].text, 'Focus on the parser.');
  assert.equal(f.steering[0].source.kind, 'dsh-crew-orchestrator');
  await assert.rejects(f.registry.message(job.id, 'another-owner', 'steal'), /access denied/);
  const answer = f.tools.get('message_parent').execute({ message: 'Which parser?', wait_for_reply: true });
  const messages = await f.registry.messages(job.id, token, 0, 0);
  const request = messages.messages[0];
  await f.registry.message(job.id, token, 'The existing one.', request.message_id);
  assert.equal((await answer).reply, 'The existing one.');
  assert.equal(f.steering.length, 1, 'a tool reply must resolve its waiter instead of enqueuing another turn');
  assert.equal(JSON.stringify(f.registry.view(job, true)).includes(token), false);
  f.finish();
  await job.promise;
  const done = await f.registry.messages(job.id, token, request.sequence, 0);
  assert.equal(done.closed, true);
  assert.equal(done.messages.at(-1).kind, 'completion');
  assert.equal(done.status, 'done');
  await assert.rejects(f.registry.message(job.id, token, 'too late'), /dispatch a new task/);
});

test('cancellation remains cancelled after idle convergence and closes the mailbox', async () => {
  const f = fixture();
  const job = await f.registry.spawn({ task: 'fixture', cwd: '/fixture', messaging_token: token });
  await f.started;
  await f.registry.cancel(job.id);
  await job.promise;
  assert.equal(job.status, 'cancelled');
  assert.equal((await f.registry.messages(job.id, token, 0, 0)).closed, true);
});
