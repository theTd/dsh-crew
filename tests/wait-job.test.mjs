// wait-job CLI (src/wait-job.mjs): the exit code is the contract.
//
// A dispatcher branches on 0/1/2/3/4, so each one is exercised against a fake
// hub here — especially 3 (still running) and 4 (unreachable/unknown), where a
// wrong code would silently turn "still working" into "failed".
//
// The child is spawned asynchronously on purpose: the fake hub lives in this
// process, and a blocking spawnSync would starve the event loop that has to
// answer the child's request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../src/wait-job.mjs', import.meta.url));

function withHub(jobs) {
  const server = createServer((req, res) => {
    const match = new URL(req.url, 'http://x').pathname.match(/\/_dsh\/dsh-crew\/jobs\/([^/]+)$/);
    const id = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    const job = id === undefined ? undefined : jobs[id];
    if (!job) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"ok":false,"error":"no such job"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, job }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

test('settled states map to 0/1/2', async () => {
  const server = await withHub({
    good: { id: 'good', status: 'done', model: 'deepseek-flash', startedAt: '2026-10-29T00:00:00Z', endedAt: '2026-10-29T00:00:02Z' },
    bad: { id: 'bad', status: 'failed', model: 'deepseek-flash' },
    ask: { id: 'ask', status: 'needs_input', model: 'deepseek-flash' },
  });
  const hub = `http://127.0.0.1:${server.address().port}`;
  try {
    const done = await run(['good', '--hub', hub, '--deadline-min', '0']);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /crew_job: /);
    assert.match(done.stdout, /"status":"done"/);
    assert.match(done.stdout, /"job_id":"good"/);

    assert.equal((await run(['bad', '--hub', hub, '--deadline-min', '0'])).status, 1);
    assert.equal((await run(['ask', '--hub', hub, '--deadline-min', '0'])).status, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('still running at the deadline is 3, with the observed status', async () => {
  const server = await withHub({ slow: { id: 'slow', status: 'running', model: 'deepseek-flash' } });
  const hub = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = await run(['slow', '--hub', hub, '--deadline-min', '0', '--interval-seconds', '1']);
    assert.equal(out.status, 3, out.stderr);
    assert.match(out.stdout, /"status":"running"/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unknown job and unreachable hub are both 4, and never claim failed', async () => {
  const server = await withHub({});
  const hub = `http://127.0.0.1:${server.address().port}`;
  try {
    const missing = await run(['ghost', '--hub', hub, '--deadline-min', '0']);
    assert.equal(missing.status, 4, missing.stderr);
    assert.match(missing.stdout, /"status":"unknown"/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
});
