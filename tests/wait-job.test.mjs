// wait-job CLI (src/wait-job.mjs): the exit code is the contract.
//
// A dispatcher branches on 0/1/2/3/4/5, so each one is exercised against a fake
// hub here — especially 3 (still running), 4 (unreachable/unknown) and 5 (a
// worker message is waiting), where a wrong code would silently turn "still
// working" into "failed" or lose a message.
//
// The child is spawned asynchronously on purpose: the fake hub lives in this
// process, and a blocking spawnSync would starve the event loop that has to
// answer the child's request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJobToken } from '../src/job-token-store.mjs';

const SCRIPT = fileURLToPath(new URL('../src/wait-job.mjs', import.meta.url));

/**
 * A fake hub with both routes. `mailboxes[id]` is `{ result }`, `{ deny: true }`
 * or `{ networkError: true }`; an absent entry is refused like a job without a
 * mailbox. `seen` records which route the CLI actually used.
 */
function withHub(jobs, mailboxes = {}) {
  const seen = { mailbox: 0, status: 0, mailboxRequests: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const match = url.pathname.match(/\/_dsh\/dsh-crew\/jobs\/([^/]+)(\/messages)?$/);
    if (match === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"error":"unknown route"}');
      return;
    }
    const id = decodeURIComponent(match[1]);
    if (match[2] !== undefined) {
      seen.mailbox += 1;
      seen.mailboxRequests.push({
        token: req.headers['x-dsh-crew-job-token'] ?? null,
        after: url.searchParams.get('after'),
        wait: url.searchParams.get('wait'),
      });
      const mailbox = mailboxes[id];
      if (mailbox?.networkError) { res.destroy(); return; }
      if (!mailbox || mailbox.deny) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"ok":false,"error":"denied"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, result: mailbox.result }));
      return;
    }
    seen.status += 1;
    const job = jobs[id];
    if (!job) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"error":"no such job"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, job }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen })));
}

async function closeHub(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** Isolate the plugin state root so token files never touch the real one. */
function useStateRoot() {
  const previous = process.env.DSHPLUGIN_CREW_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'crew-wait-state-'));
  process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
  return {
    root,
    restore() {
      if (previous === undefined) delete process.env.DSHPLUGIN_CREW_CONFIG_DIR;
      else process.env.DSHPLUGIN_CREW_CONFIG_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function run(args, stateRoot) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(stateRoot === undefined ? {} : { DSHPLUGIN_CREW_CONFIG_DIR: stateRoot }) };
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

function crewBlockOf(stdout) {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('crew_job: '));
  assert.ok(line, `no crew_job line in output:\n${stdout}`);
  return JSON.parse(line.slice('crew_job: '.length));
}

test('settled states map to 0/1/2', async () => {
  const server = await withHub({
    good: { id: 'good', status: 'done', model: 'deepseek-flash', startedAt: '2026-10-29T00:00:00Z', endedAt: '2026-10-29T00:00:02Z' },
    bad: { id: 'bad', status: 'failed', model: 'deepseek-flash' },
    ask: { id: 'ask', status: 'needs_input', model: 'deepseek-flash' },
  });
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const done = await run(['good', '--hub', hub, '--deadline-min', '0']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /crew_job: /);
    assert.match(done.stdout, /"status":"done"/);
    assert.match(done.stdout, /"job_id":"good"/);

    assert.equal((await run(['bad', '--hub', hub, '--deadline-min', '0'])).status, 1);
    assert.equal((await run(['ask', '--hub', hub, '--deadline-min', '0'])).status, 2);
  } finally {
    await closeHub(server.server);
  }
});

test('still running at the deadline is 3, with the observed status', async () => {
  const server = await withHub({ slow: { id: 'slow', status: 'running', model: 'deepseek-flash' } });
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const out = await run(['slow', '--hub', hub, '--deadline-min', '0', '--interval-seconds', '1']);
    assert.equal(out.status, 3, out.stderr);
    assert.match(out.stdout, /"status":"running"/);
  } finally {
    await closeHub(server.server);
  }
});

test('unknown job and unreachable hub are both 4, and never claim failed', async () => {
  const server = await withHub({});
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const missing = await run(['ghost', '--hub', hub, '--deadline-min', '0']);
    assert.equal(missing.status, 4, missing.stderr);
    assert.match(missing.stdout, /"status":"unknown"/);
  } finally {
    await closeHub(server.server);
  }
  const dead = await run(['x', '--hub', 'http://127.0.0.1:1', '--retries', '1', '--retry-delay-seconds', '0']);
  assert.equal(dead.status, 4, dead.stderr);
  assert.match(dead.stdout, /"error":"hub unreachable/);
  assert.doesNotMatch(dead.stdout, /"status":"failed"/);
});

test('usage errors are 64, before any request', async () => {
  assert.equal((await run([])).status, 64);
  assert.equal((await run(['id', '--retries', 'zero'])).status, 64);
  assert.equal((await run(['id', '--what'])).status, 64);
  assert.equal((await run(['id', '--after', '-1'])).status, 64);
  assert.equal((await run(['id', '--after', '1.5'])).status, 64);
  assert.equal((await run(['id', '--after'])).status, 64);
});

test('a worker message exits 5 with worker_message lines and a cursor-carrying wait command', async () => {
  const state = useStateRoot();
  const server = await withHub(
    { 'hub-7-wake': { id: 'hub-7-wake', status: 'running', model: 'deepseek-flash', startedAt: '2026-10-30T00:00:00Z' } },
    {
      'hub-7-wake': {
        result: {
          job_id: 'hub-7-wake',
          messages: [
            { sequence: 1, kind: 'message', message_id: 'already-relayed', text: 'older', expects_reply: false, created_at: '2026-10-30T00:00:01Z' },
            { sequence: 3, kind: 'message', message_id: 'm-3', text: 'which label?', expects_reply: true, created_at: '2026-10-30T00:00:03Z' },
            { sequence: 4, kind: 'completion', text: 'worker text' },
          ],
          next_cursor: 4,
          has_gap: false,
          closed: false,
          status: 'running',
        },
      },
    },
  );
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    assert.equal(writeJobToken('hub-7-wake', 'tok-wake'), true);
    const out = await run(['hub-7-wake', '--hub', hub, '--deadline-min', '0', '--interval-seconds', '1', '--after', '2'], state.root);
    assert.equal(out.status, 5, out.stderr);
    const messages = out.stdout.split('\n').filter((line) => line.startsWith('worker_message: '));
    assert.equal(messages.length, 1, 'only sequences after --after are relayed');
    assert.deepEqual(JSON.parse(messages[0].slice('worker_message: '.length)), {
      message_id: 'm-3',
      text: 'which label?',
      expects_reply: true,
      created_at: '2026-10-30T00:00:03Z',
    });
    const block = crewBlockOf(out.stdout);
    assert.equal(block.status, 'running');
    assert.match(block.wait_command, / --after 4$/);
    assert.equal(server.seen.mailbox, 1);
    assert.equal(server.seen.mailboxRequests[0].token, 'tok-wake');
    assert.equal(server.seen.mailboxRequests[0].after, '2');
    assert.equal(server.seen.status, 1, 'status is still checked after the mailbox');
  } finally {
    await closeHub(server.server);
    state.restore();
  }
});

test('a completion event never triggers 5: the settled job reports as today', async () => {
  const state = useStateRoot();
  const server = await withHub(
    { 'hub-8-done': { id: 'hub-8-done', status: 'done', model: 'deepseek-flash', result: 'all good' } },
    {
      'hub-8-done': {
        result: {
          job_id: 'hub-8-done',
          messages: [{ sequence: 1, kind: 'completion', text: 'worker text' }],
          next_cursor: 1,
          has_gap: false,
          closed: true,
          status: 'done',
        },
      },
    },
  );
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    assert.equal(writeJobToken('hub-8-done', 'tok-done'), true);
    const out = await run(['hub-8-done', '--hub', hub, '--deadline-min', '0'], state.root);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /worker_message: /);
    const block = crewBlockOf(out.stdout);
    assert.equal(block.status, 'done');
    assert.doesNotMatch(block.wait_command, /--after/);
    assert.equal(server.seen.status, 1);
  } finally {
    await closeHub(server.server);
    state.restore();
  }
});

test('without a token file the wait is status-only, exactly as before', async () => {
  const state = useStateRoot();
  const server = await withHub(
    { 'hub-9-plain': { id: 'hub-9-plain', status: 'done', model: 'deepseek-flash' } },
    {
      'hub-9-plain': {
        result: {
          job_id: 'hub-9-plain',
          messages: [{ sequence: 1, kind: 'message', message_id: 'm-1', text: 'should never be read', expects_reply: true }],
          next_cursor: 1,
          closed: false,
          status: 'running',
        },
      },
    },
  );
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const out = await run(['hub-9-plain', '--hub', hub, '--deadline-min', '0'], state.root);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /worker_message: /);
    assert.equal(server.seen.mailbox, 0, 'the mailbox must not be read without a token');
    assert.equal(server.seen.status, 1);
  } finally {
    await closeHub(server.server);
    state.restore();
  }
});

test('a denied mailbox falls back to status-only waiting', async () => {
  const state = useStateRoot();
  const server = await withHub(
    { 'hub-9-denied': { id: 'hub-9-denied', status: 'running', model: 'deepseek-flash' } },
    { 'hub-9-denied': { deny: true } },
  );
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    assert.equal(writeJobToken('hub-9-denied', 'stale-token'), true);
    const out = await run(['hub-9-denied', '--hub', hub, '--deadline-min', '0', '--interval-seconds', '1'], state.root);
    assert.equal(out.status, 3, out.stderr);
    assert.doesNotMatch(out.stdout, /worker_message: /);
    assert.equal(crewBlockOf(out.stdout).status, 'running');
    assert.equal(server.seen.mailbox, 1);
    assert.equal(server.seen.status, 1);
  } finally {
    await closeHub(server.server);
    state.restore();
  }
});

test('a mailbox network error counts like an unreachable hub (exit 4)', async () => {
  const state = useStateRoot();
  const server = await withHub(
    { 'hub-9-net': { id: 'hub-9-net', status: 'running', model: 'deepseek-flash' } },
    { 'hub-9-net': { networkError: true } },
  );
  const hub = `http://127.0.0.1:${server.server.address().port}`;
  try {
    assert.equal(writeJobToken('hub-9-net', 'tok-net'), true);
    const out = await run(['hub-9-net', '--hub', hub, '--deadline-min', '0', '--retries', '1', '--retry-delay-seconds', '0'], state.root);
    assert.equal(out.status, 4, out.stderr);
    assert.match(out.stdout, /"error":"hub unreachable/);
    assert.match(out.stdout, /"status":"unknown"/);
  } finally {
    await closeHub(server.server);
    state.restore();
  }
});
