// QA T-04: wait-job exit codes, measured through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../src/wait-job.mjs', import.meta.url));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
  });
}

test('done is 0 and an unreachable hub is 4', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, job: { id: 'j', status: 'done', model: 'm' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const done = await run(['j', '--hub', `http://127.0.0.1:${server.address().port}`, '--deadline-min', '0']);
    assert.equal(done.status, 0);
    assert.match(done.stdout, /"job_id":"j"/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const dead = await run(['x', '--hub', 'http://127.0.0.1:1', '--retries', '1', '--retry-delay-seconds', '0']);
  assert.equal(dead.status, 4);
  assert.match(dead.stdout, /"status":"unknown"/);
});
