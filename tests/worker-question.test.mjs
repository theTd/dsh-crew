import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerQuestionHandoff } from '../src/worker-question.mjs';
test('an unresolved question stops the runtime and remains visible to the caller', async () => {
  let handler, disposed = 0, published = 0;
  const ctx = { on(name, h, prepend) { assert.equal(name, 'user-questions/request'); assert.equal(prepend, true); handler = h; } };
  const job = { status: 'running', handle: { dispose() { disposed++; } } };
  installWorkerQuestionHandoff(ctx, job, () => published++);
  await assert.rejects(handler({ questions: [{ id: 'overwrite', question: 'Overwrite existing file?', options: [{ label: 'Yes' }, { label: 'No' }] }] }), /no option was selected automatically/);
  assert.equal(disposed, 1); assert.equal(published, 1); assert.equal(job.status, 'needs_input');
  assert.equal(job.questions[0].question, 'Overwrite existing file?');
  assert.equal(JSON.parse(job.result).needs_input, true);
});

import { WorkerMailbox } from '../src/worker-mailbox.mjs';

const ASK = { id: 'pwsh-recursive-delete', question: 'Allow this call?', detail: 'cmd', options: [{ label: 'Allow once' }, { label: 'Allow for this session' }, { label: 'Reject' }] };
const TOKEN = 'x'.repeat(40);

function harness({ mailbox = new WorkerMailbox(TOKEN), answerSeconds = 5 } = {}) {
  let handler, disposed = 0;
  const ctx = { on(_name, h) { handler = h; } };
  const job = { status: 'running', handle: { dispose() { disposed++; } } };
  installWorkerQuestionHandoff(ctx, job, () => {}, { currentMailbox: () => mailbox, answerSeconds });
  return { job, mailbox, ask: (q = ASK) => handler({ questions: [q] }), disposed: () => disposed };
}

async function replyWhenAsked(mailbox, text) {
  const { messages } = await mailbox.wait(0, 5);
  const asked = messages.find(m => m.expects_reply);
  assert.ok(asked, 'the orchestrator received a reply-requested message');
  assert.match(asked.text, /Options: Allow once \| Allow for this session \| Reject/);
  mailbox.reply(asked.message_id, text);
}

test('the orchestrator answers a question and the worker keeps running', async () => {
  const h = harness();
  const pending = h.ask();
  await replyWhenAsked(h.mailbox, 'allow once');
  assert.deepEqual(await pending, { answers: [{ id: ASK.id, selected: ['Allow once'] }] });
  assert.equal(h.job.status, 'running'); assert.equal(h.disposed(), 0); assert.equal(h.job.questions, undefined);
});

test('a reply that is no option label goes through as free text', async () => {
  const h = harness();
  const pending = h.ask();
  await replyWhenAsked(h.mailbox, 'use a different folder');
  assert.deepEqual(await pending, { answers: [{ id: ASK.id, selected: [], custom: 'use a different folder' }] });
});

test('no reply in time stops the worker and drops its handle', async () => {
  const h = harness({ answerSeconds: 1 });
  await assert.rejects(h.ask(), /no option was selected automatically/);
  assert.equal(h.job.status, 'needs_input'); assert.equal(h.disposed(), 1); assert.equal(h.job.handle, undefined);
});

test('a job without a mailbox stops at once', async () => {
  const h = harness({ mailbox: null });
  await assert.rejects(h.ask(), /no option was selected automatically/);
  assert.equal(h.job.status, 'needs_input'); assert.equal(h.job.handle, undefined);
});

test('a question during a continued turn acts on the current job', async () => {
  let handler;
  const spawned = { status: 'done' };
  const current = { status: 'running', handle: { dispose() {} } };
  installWorkerQuestionHandoff({ on(_n, h) { handler = h; } }, spawned, () => {}, { currentJob: () => current });
  await assert.rejects(handler({ questions: [ASK] }));
  assert.equal(current.status, 'needs_input'); assert.equal(spawned.status, 'done');
});
