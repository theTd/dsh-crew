// QA case for item 2 of T-02's DoD: the smoke probe's argument contract and the
// pinned dsh version in the isolated profile generator.
//
// The live half of T-02 (spawn → result, cancel) needs a running hub and a model
// route, so it is recorded in qa/gaps.md instead of pretending to run here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseArgsForSmoke } from '../../scripts/smoke-hub.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('smoke arguments fail loudly instead of falling back to a default hub', () => {
  assert.throws(() => parseArgsForSmoke(['--timeout', 'soon']), /--timeout must be a positive integer/);
  assert.throws(() => parseArgsForSmoke(['--unknown']), /unknown argument --unknown/);
  assert.equal(parseArgsForSmoke(['--hub', 'http://127.0.0.1:3082/']).hub, 'http://127.0.0.1:3082');
});

test('the isolated profile pins the dsh generation it was built against', () => {
  const script = readFileSync(join(ROOT, 'scripts/messaging-dev.ps1'), 'utf8');
  assert.match(script, /\$DshVersion = '0\.2\.2-alpha\.2'/);
  assert.match(script, /'@deepseek-ai\/dsh-base' = \$DshVersion/);
  assert.match(script, /'@deepseek-ai\/dsh-web-app' = \$DshVersion/);
});

test('the cancel path reads the JSON job view, not a rendered status line', () => {
  const script = readFileSync(join(ROOT, 'scripts/smoke-hub.mjs'), 'utf8');
  const cancelBlock = script.slice(script.indexOf('if (options.cancel)'), script.indexOf('const result = await client.callTool'));
  assert.match(cancelBlock, /dsh_worker_result/);
  assert.match(cancelBlock, /status === 'cancelled'/);
});
