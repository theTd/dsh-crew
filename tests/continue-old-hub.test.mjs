// A new MCP client against an OLD hub: continue still works.
//
// The old hub ignores the `messaging_token` field on POST /jobs/<id>/continue.
// The new client still mints and remembers a token and writes the waiter file,
// but the hub has no mailbox for that job, so the mailbox route is refused and
// the background waiter must fall back to today's status-only wait (no new exit
// code, no invented message). No live hub, no DSH host and no provider is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { readJobToken, tokenFilePathFor } from '../src/job-token-store.mjs';

const API = '/_dsh/dsh-crew';
const OLD_JOB_ID = 'hub-old-1';
const NEW_JOB_ID = 'hub-old-2';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/** Run the real waiter against the fake hub; the fake hub needs this event loop. */
function runWaiter(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/wait-job.mjs', ...args], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('continue on an old hub succeeds, remembers the token, and the waiter falls back to status-only', { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-old-hub-'));
  const previousRoot = process.env.DSHPLUGIN_CREW_CONFIG_DIR;
  const previousHub = process.env.DSHPLUGIN_CREW_HUB;
  process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.DSHPLUGIN_CREW_CONFIG_DIR;
    else process.env.DSHPLUGIN_CREW_CONFIG_DIR = previousRoot;
    if (previousHub === undefined) delete process.env.DSHPLUGIN_CREW_HUB;
    else process.env.DSHPLUGIN_CREW_HUB = previousHub;
    rmSync(root, { recursive: true, force: true });
  });

  const requests = [];
  const oldJobView = {
    id: NEW_JOB_ID, sessionId: 'session-old', status: 'done', result: 'old hub result',
    model: 'fixture-model', messages: { delivered: 0, pending: 0, refused: 0 },
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, search: url.search, body,
        token: req.headers['x-dsh-crew-job-token'] ?? null });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === `${API}/ping`) return send(200, { ok: true, service: 'dsh-crew-hub' });
      if (req.method === 'POST' && url.pathname === `${API}/jobs/${OLD_JOB_ID}/continue`) {
        // An old hub: the field is simply ignored, and the job has no mailbox.
        return send(200, { ok: true, job: oldJobView });
      }
      if (url.pathname === `${API}/jobs/${NEW_JOB_ID}/messages`) {
        return send(400, { ok: false, error: 'no messaging-enabled job with that id' });
      }
      if (req.method === 'GET' && url.pathname === `${API}/jobs/${NEW_JOB_ID}`) {
        return send(200, { ok: true, job: oldJobView });
      }
      return send(404, { ok: false, error: 'unknown route' });
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  process.env.DSHPLUGIN_CREW_HUB = `http://127.0.0.1:${port}`;

  // Import AFTER the env is set: hub-client resolves its base URL at module load.
  const { hub } = await import('../src/hub-client.mjs');

  const job = await hub.continueJob(OLD_JOB_ID, 'follow up on the old hub');
  assert.equal(job.id, NEW_JOB_ID);

  const continueRequest = requests.find((request) => request.path === `${API}/jobs/${OLD_JOB_ID}/continue`);
  assert.ok(continueRequest, 'continue must reach the hub');
  const payload = JSON.parse(continueRequest.body);
  assert.equal(payload.text, 'follow up on the old hub');
  assert.match(payload.messaging_token, /^[0-9a-f-]{36}$/, 'continue mints a UUID token like spawn');
  assert.equal(existsSync(tokenFilePathFor(NEW_JOB_ID)), true, 'the waiter gets the token file');

  // Storing the token is observable through the next message call: the old hub
  // refuses the mailbox, but the request carries the token this session minted.
  await assert.rejects(hub.message(NEW_JOB_ID, 'steer?'), /no messaging-enabled job/);
  const messageRequest = requests.find((request) => request.path === `${API}/jobs/${NEW_JOB_ID}/messages`);
  assert.ok(messageRequest, 'a steering call must use the stored token');
  assert.equal(messageRequest.token, payload.messaging_token);

  const waiter = await runWaiter(
    [NEW_JOB_ID, '--hub', `http://127.0.0.1:${port}`, '--deadline-min', '1', '--interval-seconds', '1'],
    { ...process.env },
  );
  assert.equal(waiter.code, 0, waiter.stderr);
  assert.match(waiter.stdout, /crew_job: .*"status":"done"/);
  assert.doesNotMatch(waiter.stdout, /worker_message:/);
  const mailboxAttempts = requests.filter((request) => request.path === `${API}/jobs/${NEW_JOB_ID}/messages`);
  assert.ok(mailboxAttempts.length > 0, 'the waiter must try the mailbox route before falling back');
  const statusAttempts = requests.filter((request) => request.method === 'GET'
    && request.path === `${API}/jobs/${NEW_JOB_ID}` && request.search.startsWith('?wait='));
  assert.ok(statusAttempts.length > 0, 'the fallback is the status-only wait');
});

/** The pretty JSON before the footer in a job tool's text. */
function parseJobBlock(text) {
  const cut = text.indexOf('\n\n[');
  assert.notEqual(cut, -1, 'a job tool must end with a footer');
  return JSON.parse(text.slice(0, cut));
}

test('the MCP continue tool still succeeds against an old hub and cleans the new token', { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'crew-old-hub-mcp-'));
  const previousRoot = process.env.DSHPLUGIN_CREW_CONFIG_DIR;
  const previousHub = process.env.DSHPLUGIN_CREW_HUB;
  process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
  const SPAWNED = 'hub-mcp-old-1';
  const CONTINUED = 'hub-mcp-old-2';
  const requests = [];
  const view = (id, status, extra = {}) => ({
    id, sessionId: 'session-old', tier: 'flash', model: 'fixture-model', provider: 'fixture',
    effort: 'off', status, source: 'claude-code', task: 'fixture', cwd: root, turn: 0, step: 0,
    currentTool: null, toolCalls: 0, tokens: { input: 0, output: 0, reasoning: 0 }, mode: 'hub',
    messages: { delivered: 0, pending: 0, refused: 0 }, continued_from: null,
    lease_expires_at: null, startedAt: new Date().toISOString(),
    endedAt: status === 'running' ? null : new Date().toISOString(),
    result: status === 'done' ? 'old hub result' : null, error: null,
    stopReason: status === 'done' ? 'completed' : null, ...extra,
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, body });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === `${API}/ping`) return send(200, { ok: true, service: 'dsh-crew-hub' });
      if (req.method === 'POST' && url.pathname === `${API}/jobs`) {
        // An old hub: the spawn token is ignored and the job reports as settled.
        return send(200, { ok: true, job: view(SPAWNED, 'done') });
      }
      if (req.method === 'POST' && url.pathname === `${API}/jobs/${SPAWNED}/continue`) {
        // It also ignores messaging_token here and has no mailbox for the job.
        return send(200, { ok: true, job: view(CONTINUED, 'running', { continued_from: SPAWNED }) });
      }
      if (url.pathname === `${API}/jobs/${CONTINUED}/messages`) {
        return send(400, { ok: false, error: 'no messaging-enabled job with that id' });
      }
      if (req.method === 'GET' && url.pathname === `${API}/jobs/${CONTINUED}`) {
        return send(200, { ok: true, job: view(CONTINUED, 'done', { continued_from: SPAWNED }) });
      }
      if (req.method === 'GET' && url.pathname === `${API}/jobs/${SPAWNED}`) {
        return send(200, { ok: true, job: view(SPAWNED, 'done') });
      }
      if (req.method === 'GET' && url.pathname === `${API}/jobs`) {
        return send(200, { ok: true, jobs: [view(SPAWNED, 'done'), view(CONTINUED, 'done', { continued_from: SPAWNED })] });
      }
      return send(404, { ok: false, error: 'unknown route' });
    });
  });
  const port = await listen(server);
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    await close(server);
    if (previousRoot === undefined) delete process.env.DSHPLUGIN_CREW_CONFIG_DIR;
    else process.env.DSHPLUGIN_CREW_CONFIG_DIR = previousRoot;
    if (previousHub === undefined) delete process.env.DSHPLUGIN_CREW_HUB;
    else process.env.DSHPLUGIN_CREW_HUB = previousHub;
    rmSync(root, { recursive: true, force: true });
  });

  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  client = new Client({ name: 'old-hub-compat', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    env: { ...env, CLAUDECODE: '1', DSHPLUGIN_CREW_CONFIG_DIR: root,
      DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${port}` },
  }));

  const spawned = await client.callTool({ name: 'dsh_spawn_worker', arguments: {
    task: 'old hub spawn', cwd: root, tier: 'flash',
  } });
  assert.notEqual(spawned.isError, true);
  assert.equal(parseJobBlock(spawned.content[0].text).id, SPAWNED);
  // Observe the settled spawn so its cwd lock is released before the continue.
  const spawnedResult = await client.callTool({ name: 'dsh_worker_result', arguments: { job_id: SPAWNED } });
  assert.match(spawnedResult.content[0].text, /"status": "done"/);

  const continued = await client.callTool({ name: 'dsh_worker_continue', arguments: {
    job_id: SPAWNED, text: 'follow up through the old hub',
  } });
  assert.notEqual(continued.isError, true);
  const continuedView = parseJobBlock(continued.content[0].text);
  assert.equal(continuedView.id, CONTINUED);
  assert.equal(continuedView.continued_from, SPAWNED);

  const continueRequest = requests.find((request) => request.method === 'POST'
    && request.path === `${API}/jobs/${SPAWNED}/continue`);
  assert.ok(continueRequest, 'the MCP tool must reach the old hub continue route');
  const payload = JSON.parse(continueRequest.body);
  assert.equal(payload.text, 'follow up through the old hub');
  assert.match(payload.messaging_token, /^[0-9a-f-]{36}$/);
  assert.equal(readJobToken(CONTINUED), payload.messaging_token);
  assert.equal(existsSync(tokenFilePathFor(CONTINUED)), true);

  // The old hub has no mailbox, so the token is only kept until the client sees
  // the job settled; then the token file is removed like any other.
  const continuedResult = await client.callTool({ name: 'dsh_worker_result', arguments: {
    job_id: CONTINUED, wait_seconds: 1,
  } });
  assert.match(continuedResult.content[0].text, /"status": "done"/);
  assert.equal(existsSync(tokenFilePathFor(CONTINUED)), false);
});

