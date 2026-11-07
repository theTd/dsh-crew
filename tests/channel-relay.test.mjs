import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRelay } from '../src/channel-relay.mjs';

test('relay pushes worker questions and completion with job routing metadata', async () => {
  const sent = [], reads = [];
  const relay = new ChannelRelay({
    async read(id, cursor) {
      reads.push([id, cursor]);
      return { messages: [
        { sequence: 1, message_id: 'q1', kind: 'message', text: 'Which file?', expects_reply: true },
        { sequence: 2, message_id: 'done', kind: 'completion', text: 'Finished.', status: 'done' },
      ], next_cursor: 2, closed: true, has_gap: false };
    },
    async notify(notification) { sent.push(notification); },
  });
  relay.watch('hub-own');
  relay.watch('hub-own');
  await relay.jobs.get('hub-own').promise;
  assert.deepEqual(reads, [['hub-own', 0]]);
  assert.equal(sent[0].method, 'notifications/claude/channel');
  assert.equal(sent[0].params.meta.job_id, 'hub-own');
  assert.equal(sent[0].params.meta.reply_requested, 'true');
  assert.match(sent[0].params.content, /not human approval/);
  assert.equal(sent[1].params.meta.status, 'done');
  await relay.close();
});

test('relay shuts down pending hub reads when the MCP connection closes', async () => {
  let aborted = false;
  const relay = new ChannelRelay({
    read(_id, _cursor, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true; reject(signal.reason);
      }, { once: true }));
    },
    async notify() { assert.fail('no messages expected'); },
    onError() { assert.fail('normal disconnect is not a relay error'); },
  });
  relay.watch('hub-own');
  await relay.close();
  assert.equal(aborted, true);
  assert.equal(relay.jobs.size, 0);
});
