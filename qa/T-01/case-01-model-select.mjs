// QA case for item 1 of T-01's DoD (independent of tests/hub-model-selection.test.mjs).
//
// The check does not import the unit test: it reads the hub the way the next
// reader will, and it proves the forbidden 0.2.2 pattern is absent rather than
// trusting a comment that says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyModelSelection } from '../../src/hub/model-selection.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('hub registers no agent/request rewrite and selects on the agent instead', () => {
  const source = readFileSync(join(ROOT, 'src/hub/index.mjs'), 'utf8');
  assert.equal(/\.on\(\s*['"]agent\/request['"]/.test(source), false);
  assert.equal(source.includes('installModelSelection'), false);
  const selectAt = source.indexOf('applyModelSelection(');
  const followupAt = source.indexOf('handle.agent.followup(');
  assert.ok(selectAt > -1, 'the hub must call applyModelSelection');
  assert.ok(selectAt < followupAt, 'the route must be selected before the first step');
});

test('a live agent receives the dispatch route through model.select', () => {
  const seen = [];
  applyModelSelection({ model: { select: (selection) => seen.push(selection) } },
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
  assert.deepEqual(seen, [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }]);
});

test('a host without model.select refuses with one fixed sentence', () => {
  assert.throws(() => applyModelSelection({}, { provider: 'p', model: 'm' }),
    { message: 'dsh-crew: agent.model.select is not available on this dsh' });
});
