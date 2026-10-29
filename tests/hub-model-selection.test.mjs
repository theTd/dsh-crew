// Worker model selection on dsh 0.2.2 (src/hub/model-selection.mjs).
//
// 0.2.2 removed the 0.1.x escape hatch: a listener on `agent/request` may no
// longer rewrite `provider`/`model` — the loop throws "proposed ... after step
// preparation fixed ...; use agent.model.select()". So the hub must ask the
// agent's own model accessor before the first step, and must not keep the old
// hook around: keeping it dead would still be one edit away from the throw.
//
// These tests pin both halves: the call the hub makes, and the absence of the
// forbidden listener in the module that used to register it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyModelSelection } from '../src/hub/model-selection.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakeAgent() {
  const calls = [];
  return {
    calls,
    model: {
      select(selection) {
        calls.push(selection);
      },
    },
  };
}

test('selects the dispatch route before the first step', () => {
  const agent = fakeAgent();
  applyModelSelection(agent, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
  });
});

test('an unset reasoning effort is left to the dsh default', () => {
  const agent = fakeAgent();
  applyModelSelection(agent, { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.deepEqual(agent.calls[0], { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.equal('reasoningEffort' in agent.calls[0], false);
});

test('a dsh without model.select fails with one fixed sentence', () => {
  assert.throws(
    () => applyModelSelection({}, { provider: 'p', model: 'm' }),
    { message: 'dsh-crew: agent.model.select is not available on this dsh' },
  );
  assert.throws(
    () => applyModelSelection({ model: {} }, { provider: 'p', model: 'm' }),
    { message: 'dsh-crew: agent.model.select is not available on this dsh' },
  );
});

test('the hub keeps no agent/request rewrite and calls the accessor', () => {
  const source = readFileSync(join(ROOT, 'src/hub/index.mjs'), 'utf8');
  assert.equal(
    /\.on\(\s*['"]agent\/request['"]/.test(source),
    false,
    'src/hub/index.mjs must not register an agent/request listener',
  );
  assert.equal(source.includes('installModelSelection'), false, 'the 0.1.x model-selection hook must be gone, not disabled');
  assert.match(source, /applyModelSelection\(/, 'the hub must apply the dispatch route through agent.model.select()');
});

test('the hub passes the resolved dispatch route into model.select', async () => {
  const { WorkerRegistry } = await import('../src/hub/index.mjs');
  const selected = [];
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'standard' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        await options.setup({ on() {}, tools: { register() {} } });
        const agent = {
          session: {},
          model: { select: (selection) => selected.push(selection) },
          async whenIdle() {},
          followup() {},
        };
        return { agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });
  const override = await registry.spawn({
    task: 'fixture', cwd: '/fixture', tier: 'pro', effort: 'max', provider: 'clay', model: 'deepseek-flash',
  });
  await override.promise;
  assert.deepEqual(selected[0], { provider: 'clay', model: 'deepseek-flash', reasoningEffort: 'max' });

  const shipped = await registry.spawn({ task: 'fixture', cwd: '/fixture', tier: 'pro', effort: 'high' });
  await shipped.promise;
  assert.deepEqual(selected[1], { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' });
});
