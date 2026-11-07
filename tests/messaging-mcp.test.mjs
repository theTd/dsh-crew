import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import { tokenFilePathFor } from '../src/job-token-store.mjs';

// Actual hub routes + actual MCP process; only the DSH model/driver is a fixture.
// No provider key, Claude session or external request is used by this test.
test('MCP and hub carry a worker question, parent reply and completion over the wire', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'crew-mcp-messages-'));
  const originalRoot = process.env.DSHPLUGIN_CREW_CONFIG_DIR;
  process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
  let client, http, disposeHub;
  t.after(async () => {
    await client?.close();
    await disposeHub?.();
    if (http?.listening) {
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
    if (originalRoot === undefined) delete process.env.DSHPLUGIN_CREW_CONFIG_DIR;
    else process.env.DSHPLUGIN_CREW_CONFIG_DIR = originalRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const routes = [];
  const { apply } = await import('../src/hub/index.mjs');
  const ctx = {
    get() {}, sessions: { async flush() {} }, tools: { register() { return () => {}; } },
    effect(fn) { return fn(); },
    inject(_dependencies, fn) { return fn({ webServer: { register(route) { routes.push(route); return () => {}; } } }); },
    agents: { async create(options) {
      const tools = new Map(), listeners = new Map(), controller = new AbortController();
      let idle = Promise.resolve();
      let turn = 0;
      await options.setup({ on(name, fn) { listeners.set(name, fn); },
        tools: { register(tool) {
          // Registration must receive the same object schema a provider sees;
          // this fixture must not silently accept the compact defineTool DSL.
          assert.equal(tool.parameters.type, 'object');
          assert.equal(tool.parameters.properties?.message?.type, 'string');
          assert.ok(tool.parameters.required?.includes('message'));
          tools.set(tool.name, tool);
        } } });
      const agent = {
        session: {}, model: { select() {} }, async whenIdle() { await idle; }, steer() {},
        followup() {
          turn += 1;
          const current = turn;
          idle = (async () => {
            const response = await tools.get('message_parent').execute({
              message: current === 1 ? 'Choose a label for this fixture.' : 'And a second label?',
              wait_for_reply: true,
            }, { signal: controller.signal });
            listeners.get('session/event')({}, { type: 'assistant/message', data: {
              message: { content: [{ type: 'text', text: `Received: ${response.reply}` }] },
            } });
            listeners.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          })();
        },
      };
      return { agent, async dispose() { controller.abort(); await idle.catch(() => {}); } };
    } },
  };
  disposeHub = await apply(ctx);
  http = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const route = routes.find(r => r.kind === 'exact' ? r.path === path : path.startsWith(r.path));
    if (!route) { res.writeHead(404).end(); return; }
    Promise.resolve(route.handler(req, res)).catch(error => { if (!res.destroyed) res.writeHead(500).end(error.message); });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  client = new Client({ name: 'messaging-fixture', version: '1' });
  const received = [];
  const waiters = new Set();
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'),
    params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }) }), notification => {
    received.push(notification.params);
    for (const wake of waiters) wake();
  });
  async function incoming(kind, match = () => true) {
    for (;;) {
      const item = received.find(message => message.meta?.kind === kind && match(message));
      if (item) return item;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(wake); reject(new Error('channel delivery timed out')); }, 5000);
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
        waiters.add(wake);
      });
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...env, CLAUDECODE: '1', DSHPLUGIN_CREW_CONFIG_DIR: root, DSHPLUGIN_CREW_CHANNELS: '1',
      DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${http.address().port}` },
  }));
  assert.ok(client.getServerCapabilities().experimental['claude/channel']);
  const result = await client.callTool({ name: 'dsh_spawn_worker', arguments: {
    task: 'fixture only', cwd: root, tier: 'flash',
  } });
  assert.notEqual(result.isError, true);
  // Job tools end with a footer and a `crew_job:` line after the JSON body.
  const spawnText = result.content[0].text;
  assert.match(spawnText, /\n\n\[dsh \| job /);
  const job = JSON.parse(spawnText.slice(0, spawnText.indexOf('\n\n[')));
  assert.equal(existsSync(tokenFilePathFor(job.id)), true, 'spawn must hand the job token to the background waiter');
  const question = await incoming('message', message => message.meta?.job_id === job.id);
  assert.equal(question.meta.job_id, job.id);
  assert.equal(question.meta.reply_requested, 'true');
  const reply = await client.callTool({ name: 'dsh_worker_message', arguments: {
    job_id: job.id, message: 'violet', reply_to: question.meta.message_id,
  } });
  assert.equal(JSON.parse(reply.content[0].text).delivery, 'tool_reply');
  assert.match((await incoming('completion', message => message.meta?.job_id === job.id)).content, /Received: violet/);
  const mailbox = await client.callTool({ name: 'dsh_worker_messages', arguments: { job_id: job.id } });
  assert.equal(JSON.parse(mailbox.content[0].text).messages.length, 2, 'channel delivery must not consume the polling mailbox');

  // The settled job ends its token handoff: the waiter no longer needs it.
  const settled = await client.callTool({ name: 'dsh_worker_result', arguments: { job_id: job.id } });
  assert.match(settled.content[0].text, /"status": "done"/);
  assert.equal(existsSync(tokenFilePathFor(job.id)), false, 'observing a settled job removes its token file');

  // Token ownership is enforced on the wire, not only in-process: a missing or
  // foreign token must be refused by the hub route itself.
  const route = `http://127.0.0.1:${http.address().port}/_dsh/dsh-crew/jobs/${job.id}/messages?after=0&wait=0`;
  for (const headers of [{}, { 'x-dsh-crew-job-token': 'foreign-token' }]) {
    const refused = await fetch(route, { headers });
    assert.equal(refused.status, 400, 'a message read without the owning token must be refused');
  }

  // A continued job is messaging-enabled exactly like a spawned one. The
  // continuation turn's message_parent must land in the NEW job's mailbox —
  // the spawn-time mailbox is closed — and the token handoff must follow it.
  const continued = await client.callTool({ name: 'dsh_worker_continue', arguments: {
    job_id: job.id, text: 'One more question, please.',
  } });
  assert.notEqual(continued.isError, true);
  const continuedText = continued.content[0].text;
  assert.match(continuedText, /\n\n\[dsh \| job /);
  const continuedJob = JSON.parse(continuedText.slice(0, continuedText.indexOf('\n\n[')));
  assert.equal(continuedJob.continued_from, job.id);
  assert.equal(existsSync(tokenFilePathFor(continuedJob.id)), true, 'continue must hand the new job token to the background waiter');

  const secondQuestion = await incoming('message', message => message.meta?.job_id === continuedJob.id);
  assert.equal(secondQuestion.meta.reply_requested, 'true');
  assert.match(secondQuestion.content, /And a second label\?/);
  const secondReply = await client.callTool({ name: 'dsh_worker_message', arguments: {
    job_id: continuedJob.id, message: 'indigo', reply_to: secondQuestion.meta.message_id,
  } });
  assert.equal(JSON.parse(secondReply.content[0].text).delivery, 'tool_reply');
  assert.match((await incoming('completion', message => message.meta?.job_id === continuedJob.id)).content, /Received: indigo/);

  const continuedMailbox = await client.callTool({ name: 'dsh_worker_messages', arguments: { job_id: continuedJob.id } });
  assert.equal(JSON.parse(continuedMailbox.content[0].text).messages.length, 2,
    'the continued mailbox replays its question and completion');
  const continuedSettled = await client.callTool({ name: 'dsh_worker_result', arguments: { job_id: continuedJob.id } });
  assert.match(continuedSettled.content[0].text, /"status": "done"/);
  assert.equal(existsSync(tokenFilePathFor(continuedJob.id)), false,
    'observing the settled continued job removes its token file');
});
