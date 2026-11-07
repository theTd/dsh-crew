import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerMailbox, parentMessageTool } from '../src/worker-mailbox.mjs';

const token = 'owner-token-'.repeat(4);

test('the raw-registration boundary exposes model-facing JSON Schema without a compilation step', () => {
  const tool = parentMessageTool(new WorkerMailbox(token));
  // The real registry's schemaOf() snapshots parameters without compiling them.
  const parameters = structuredClone(tool.parameters);
  assert.equal(parameters.type, 'object');
  assert.equal(parameters.properties?.message?.type, 'string');
  assert.ok(parameters.required?.includes('message'));
  assert.equal(parameters.additionalProperties, false);
});

test('invalid arguments cannot enqueue messages or create pending reply waits', async () => {
  const mailbox = new WorkerMailbox(token);
  const tool = parentMessageTool(mailbox);
  for (const args of [null, [], {}, { message: 42 }, { message: ' ' },
    { message: 'question', wait_for_reply: 'false' },
    { message: 'question', timeout_seconds: 0 },
    { message: 'question', timeout_seconds: 181 },
    { message: 'question', timeout_seconds: 1.5 },
    { message: 'question', timeout_seconds: null },
    { message: 'question', unexpected: true }]) {
    await assert.rejects(tool.execute(args));
  }
  assert.equal(mailbox.read().messages.length, 0);
  assert.equal(mailbox.replies.size, 0);
  assert.equal((await tool.execute({ message: 'valid update' })).accepted, true);
});

test('mailboxes reject other owners and readers have independent cursors', () => {
  const mailbox = new WorkerMailbox(token);
  assert.throws(() => mailbox.authorize('different-token'), /access denied/);
  mailbox.authorize(token);
  const first = mailbox.append('message', 'Found an issue.');
  mailbox.append('message', 'Checking the fix.');
  assert.equal(mailbox.read(0).messages.length, 2);
  assert.equal(mailbox.read(0).messages.length, 2, 'channel reads must not consume polling results');
  assert.equal(mailbox.read(first.sequence).messages.length, 1);
  assert.throws(() => mailbox.read(100), /cursor/);
  assert.throws(() => mailbox.append('message', ' '), /non-empty/);
  assert.throws(() => mailbox.append('message', 'x'.repeat(16_001)), /16/);
});

test('bounded replay explicitly reports lost events', () => {
  const mailbox = new WorkerMailbox(token);
  for (let n = 0; n < 260; n++) mailbox.append('message', `Update ${n}`);
  const batch = mailbox.read(0);
  assert.equal(batch.messages.length, 256);
  assert.equal(batch.has_gap, true);
  assert.equal(batch.next_cursor, 260);
  assert.equal(mailbox.read(4).has_gap, false);
});

test('worker tools wait for a correlated answer without interpreting it as approval', async () => {
  const mailbox = new WorkerMailbox(token);
  const tool = parentMessageTool(mailbox);
  const response = tool.execute({ message: 'Which parser should I use?', wait_for_reply: true });
  const incoming = mailbox.read().messages[0];
  assert.equal(incoming.expects_reply, true);
  mailbox.reply(incoming.message_id, 'Use the existing parser; preserve confirmation requirements.');
  assert.equal((await response).reply, 'Use the existing parser; preserve confirmation requirements.');
  assert.throws(() => mailbox.reply(incoming.message_id, 'duplicate'), /not pending/);
});

test('reply waits abort and close without leaking listeners or pending requests', async () => {
  const mailbox = new WorkerMailbox(token);
  const controller = new AbortController();
  const pending = mailbox.request('Please clarify.', 60, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(mailbox.replies.size, 0);
  const waiting = mailbox.request('Another question.', 60);
  const closed = assert.rejects(waiting, /closed/);
  mailbox.close();
  await closed;
  assert.equal(mailbox.replies.size, 0);
});

test('long-poll waits wake on delivery and disconnect without retaining timers', async () => {
  const mailbox = new WorkerMailbox(token);
  const waiting = mailbox.wait(0, 30);
  mailbox.append('message', 'Ready.');
  assert.equal((await waiting).messages[0].text, 'Ready.');
  const controller = new AbortController();
  const interrupted = mailbox.wait(1, 30, controller.signal);
  const rejected = assert.rejects(interrupted, /disconnected/);
  controller.abort(new Error('disconnected'));
  await rejected;
  assert.equal(mailbox.waiters.size, 0);
});

test('timed-out requests return an explicit timeout, never an invented answer', async () => {
  const mailbox = new WorkerMailbox(token);
  const result = await mailbox.request('Need an answer.', 1);
  assert.equal(result.timed_out, true);
  assert.equal('reply' in result, false);
  assert.equal(mailbox.replies.size, 0);
});
