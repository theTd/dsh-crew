// QA T-03: every job-returning tool ends with the crew_job block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { withCrewBlock } from '../../src/crew-block.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the block parses and the hub job tools use it', () => {
  const out = withCrewBlock('body', { id: 'hub-9', status: 'done', model: 'm', tokens: { input: 1, output: 2 }, step: 1, toolCalls: 1 });
  const line = out.split('\n').at(-1);
  assert.match(line, /^crew_job: \{/);
  const block = JSON.parse(line.slice('crew_job: '.length));
  assert.equal(block.crew, 'dsh');
  assert.equal(block.job_id, 'hub-9');
  assert.match(out, /\n\[dsh \| job hub-9 \| done \|/);

  const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
  for (const handler of ['dsh_spawn_worker', 'dsh_worker_result', 'dsh_worker_cancel', 'dsh_worker_log']) {
    const start = server.indexOf(`registerTool('${handler}'`);
    const next = server.indexOf('registerTool(', start + 10);
    assert.match(server.slice(start, next === -1 ? undefined : next), /jobText\(|withCrewBlock\(/, `${handler} must end with a crew_job block`);
  }
});
