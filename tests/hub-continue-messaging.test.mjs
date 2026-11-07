// Continue a settled job with a messaging token (src/hub/index.mjs continueJob).
//
// A continuation is a NEW job record on the SAME agent/session. The worker tool
// must therefore resolve its mailbox at call time: the spawn-time mailbox is
// closed when the spawn settles, while the continuation owns a fresh one. These
// cases cover both continue paths (live handle reuse and persisted resume), the
// token-less continuation, and the "register the tool once" rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../src/hub/index.mjs';

const TOKEN_A = 'continue-owner-token-a-'.repeat(2);
const TOKEN_B = 'continue-owner-token-b-'.repeat(2);
const TOKEN_C = 'continue-owner-token-c-'.repeat(2);

/**
 * A worker fixture that runs a scripted callback per turn. Each agent exposes
 * its own tool registry, so a test can tell a spawn-time registration from a
 * resume-time one, and count registrations on an agent that is reused.
 */
function fixture(onTurn) {
  const events = new Map();
  const resumed = [];
  const agents = [];
  let idle = Promise.resolve();
  let turns = 0;

  const makeAgentParts = (kind) => {
    const tools = new Map();
    const registrations = [];
    const agentCtx = {
      on(name, fn) { events.set(name, fn); },
      tools: {
        register(tool) {
          tools.set(tool.name, tool);
          registrations.push(tool.name);
          return () => {};
        },
      },
    };
    return { kind, tools, registrations, agentCtx };
  };

  const emit = (text) => {
    events.get('session/event')({}, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    });
    events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  };

  const buildAgent = (tools) => ({
    session: {},
    model: { select() {} },
    steering: [],
    async whenIdle() { await idle; },
    steer(message) { this.steering.push(message); },
    followup() {
      turns += 1;
      const turn = turns;
      idle = (async () => {
        const answer = await onTurn(turn, tools);
        if (answer !== undefined) emit(answer);
      })();
    },
  });

  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      }
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        const parts = makeAgentParts('created');
        await options.setup(parts.agentCtx);
        const agent = buildAgent(parts.tools);
        agents.push({ ...parts, agent });
        return { agent, async dispose() {} };
      },
      async resume(options) {
        resumed.push(options.resumeSessionId);
        const parts = makeAgentParts('resumed');
        await options.setup(parts.agentCtx);
        const agent = buildAgent(parts.tools);
        agents.push({ ...parts, agent });
        return { agent, async dispose() {} };
      },
    },
  };

  const registry = new WorkerRegistry(ctx, { publish() {} });
  return {
    registry,
    agents,
    resumed,
    registrations: () => agents.flatMap(agent => agent.registrations),
    steering: () => agents.flatMap(agent => agent.agent.steering),
  };
}

/** The first unread reply-request in a mailbox (polling read with a short wait). */
async function nextRequest(registry, jobId, token) {
  const batch = await registry.messages(jobId, token, 0, 5);
  return batch.messages.find(event => event.kind === 'message' && event.expects_reply === true);
}

test('a live continuation with a token is steerable and message_parent writes into the NEW mailbox', async () => {
  const f = fixture(async (turn, tools) => {
    if (turn === 1) return 'first answer';
    const tool = tools.get('message_parent');
    if (!tool) return 'missing message_parent tool';
    const response = await tool.execute({ message: 'question from the continuation', wait_for_reply: true });
    return `reply: ${response.reply}`;
  });

  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', messaging_token: TOKEN_A, timeout_seconds: 30 });
  await first.promise;
  assert.equal(first.status, 'done');
  assert.equal((await f.registry.messages(first.id, TOKEN_A, 0, 0)).closed, true);

  const second = await f.registry.continueJob(first.id, 'follow up', { messaging_token: TOKEN_B });
  assert.notEqual(second.mailbox, null, 'a continuation with a token owns a mailbox');
  await second.started;

  const steered = await f.registry.message(second.id, TOKEN_B, 'steer the continuation');
  assert.equal(steered.delivery, 'next_step');
  assert.equal(f.steering()[0].content[0].text, 'steer the continuation');

  const request = await nextRequest(f.registry, second.id, TOKEN_B);
  assert.ok(request, 'message_parent must append to the continued job mailbox');
  assert.equal(request.text, 'question from the continuation');
  await f.registry.message(second.id, TOKEN_B, 'answer for the continuation', request.message_id);

  await second.promise;
  assert.equal(second.status, 'done', second.error);
  assert.equal(second.result, 'reply: answer for the continuation');

  const oldEvents = await f.registry.messages(first.id, TOKEN_A, 0, 0);
  assert.equal(
    oldEvents.messages.some(event => event.text === 'question from the continuation'),
    false,
    'the continuation must not write into the previous job mailbox',
  );

  const done = await f.registry.messages(second.id, TOKEN_B, request.sequence, 0);
  assert.equal(done.closed, true);
  assert.equal(done.messages.at(-1).kind, 'completion');
  assert.equal(done.status, 'done');

  await assert.rejects(f.registry.message(second.id, TOKEN_B, 'too late'), /dispatch a new task/);
  await assert.rejects(f.registry.message(second.id, TOKEN_A, 'old token'), /access denied/);
  assert.deepEqual(f.registrations(), ['message_parent'], 'a live continuation reuses the spawn-time tool');
});

test('a cold continuation registers message_parent once on the resumed agent and uses its own mailbox', async () => {
  const f = fixture(async (turn, tools) => {
    if (turn === 1) return 'first answer';
    if (turn === 3) return 'third after restart';
    const tool = tools.get('message_parent');
    if (!tool) return 'resumed agent has no message_parent tool';
    const response = await tool.execute({ message: 'question after a hub restart', wait_for_reply: true });
    return `cold reply: ${response.reply}`;
  });

  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', messaging_token: TOKEN_A });
  await first.promise;
  first.handle = undefined; // hub restarted: nothing live to reuse

  const second = await f.registry.continueJob(first.id, 'after restart', { messaging_token: TOKEN_B });
  await second.started;
  assert.deepEqual(f.resumed, [first.sessionId]);
  const resumedAgents = f.agents.filter(agent => agent.kind === 'resumed');
  assert.equal(resumedAgents.length, 1);
  assert.deepEqual(resumedAgents[0].registrations, ['message_parent']);

  const request = await nextRequest(f.registry, second.id, TOKEN_B);
  assert.ok(request, 'the resumed turn must write into the continuation mailbox');
  await f.registry.message(second.id, TOKEN_B, 'cold answer', request.message_id);

  await second.promise;
  assert.equal(second.status, 'done', second.error);
  assert.equal(second.result, 'cold reply: cold answer');
  assert.equal((await f.registry.messages(second.id, TOKEN_B, request.sequence, 0)).closed, true);

  // The resumed handle can be continued again, live this time. Its listeners
  // must follow the newest job (the resumed agent was not born with them).
  const third = await f.registry.continueJob(second.id, 'one more after the restart', { messaging_token: TOKEN_C });
  await third.promise;
  assert.equal(third.status, 'done', third.error);
  assert.equal(third.result, 'third after restart');
  assert.deepEqual(f.resumed, [first.sessionId], 'a live continuation must not resume the session again');
  const thirdDone = await f.registry.messages(third.id, TOKEN_C, 0, 0);
  assert.equal(thirdDone.closed, true);
  assert.equal(thirdDone.messages.at(-1).kind, 'completion');
  assert.deepEqual(f.registrations(), ['message_parent', 'message_parent'],
    'the spawn and each resumed agent register the tool once');
});

test('a continuation without a token keeps mailbox null and message_parent says so clearly', async () => {
  let toolError;
  const f = fixture(async (turn, tools) => {
    if (turn === 1) return 'first answer';
    try {
      await tools.get('message_parent').execute({ message: 'anyone there?' });
      return 'tool unexpectedly accepted a message';
    } catch (err) {
      toolError = err?.message;
      return 'no mailbox';
    }
  });

  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture', messaging_token: TOKEN_A });
  await first.promise;
  const second = await f.registry.continueJob(first.id, 'no token follow-up');
  assert.equal(second.mailbox, null);
  await second.promise;
  assert.equal(second.status, 'done', second.error);
  assert.match(toolError, /no open mailbox/);
  assert.doesNotMatch(toolError, /worker mailbox is closed/);

  // The old job's mailbox is neither reused nor reachable through the new job.
  await assert.rejects(f.registry.message(second.id, TOKEN_A, 'steer'), /no messaging-enabled job/);
  await assert.rejects(f.registry.messages(second.id, TOKEN_A, 0, 0), /no messaging-enabled job/);
  assert.equal((await f.registry.messages(first.id, TOKEN_A, 0, 0)).closed, true);
  assert.deepEqual(f.registrations(), ['message_parent'], 'the no-token turn reuses the old tool and adds none');
});

test('a live continuation adds message_parent exactly once when the spawn had no token', async () => {
  const f = fixture(async (turn, tools) => {
    if (turn === 1) return 'first answer';
    if (turn > 2) return `turn ${turn} answer`;
    const tool = tools.get('message_parent');
    if (!tool) return 'lazily registered tool missing';
    const response = await tool.execute({ message: 'added later', wait_for_reply: true });
    return `late tool: ${response.reply}`;
  });

  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture' });
  await first.promise;
  assert.deepEqual(f.registrations(), [], 'a spawn without a mailbox registers no worker tool');

  const second = await f.registry.continueJob(first.id, 'now with a token', { messaging_token: TOKEN_B });
  await second.started;
  assert.deepEqual(f.agents[0].registrations, ['message_parent']);

  const request = await nextRequest(f.registry, second.id, TOKEN_B);
  assert.ok(request);
  await f.registry.message(second.id, TOKEN_B, 'late reply', request.message_id);
  await second.promise;
  assert.equal(second.status, 'done', second.error);
  assert.equal(second.result, 'late tool: late reply');

  // A second continuation on the same live agent must not add a duplicate tool;
  // its resolver simply follows the newest job.
  const third = await f.registry.continueJob(second.id, 'a third turn', { messaging_token: TOKEN_C });
  await third.promise;
  assert.equal(third.status, 'done', third.error);
  assert.equal(third.result, 'turn 3 answer');
  assert.deepEqual(f.registrations(), ['message_parent']);
});

test('an invalid token is refused before the continuation is claimed', async () => {
  const f = fixture(async () => 'answer');
  const first = await f.registry.spawn({ task: 'first', cwd: '/fixture' });
  await first.promise;

  await assert.rejects(
    f.registry.continueJob(first.id, 'bad token', { messaging_token: 'too-short' }),
    /32.128 characters/,
  );
  const second = await f.registry.continueJob(first.id, 'valid token', { messaging_token: TOKEN_B });
  await second.promise;
  assert.equal(second.status, 'done', second.error);
  assert.notEqual(second.mailbox, null);
});
