// QA T-08: continue keeps the session and links the new job to the old one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkerRegistry } from '../../src/hub/index.mjs';

function fixture() {
  const events = new Map();
  let turns = 0;
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on(n, f) { events.set(n, f); }, tools: { register() {} } });
        return {
          agent: {
            session: {}, model: { select() {} }, async whenIdle() {},
            followup() {
              turns += 1;
              events.get('session/event')({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: turns === 1 ? 'one' : 'two' }] } } });
              events.get('session/event')({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
            },
          },
          async dispose() {},
        };
      },
    },
  };
  return new WorkerRegistry(ctx, { publish() {} });
}

test('the continuation reuses the session and records continued_from', async () => {
  const registry = fixture();
  const first = await registry.spawn({ task: 'first', cwd: '/fixture', timeout_seconds: 30 });
  await first.promise;
  const second = await registry.continueJob(first.id, 'again');
  await second.promise;
  assert.equal(second.result, 'two');
  assert.equal(second.continued_from, first.id);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(registry.view(second).continued_from, first.id);
});

test('the MCP tool only continues a job this session spawned', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
  const start = server.indexOf("registerTool('dsh_worker_continue'");
  const block = server.slice(start, server.indexOf('registerTool(', start + 10));
  assert.match(block, /sessionJobIds\.has\(job_id\)/, 'continue must not adopt another session\'s job');
  assert.match(block, /acquireDispatchLock/, 'continue must take the cwd lock');
});
