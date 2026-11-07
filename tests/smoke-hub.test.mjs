// scripts/smoke-hub.mjs argument handling (M1 acceptance probe).
//
// The probe is what decides whether a milestone is "really running", so its
// argument errors must be loud before any model call: a typo must exit 2 with a
// readable sentence, never fall back to a default hub and test the wrong thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgsForSmoke } from '../scripts/smoke-hub.mjs';

test('defaults point at the isolated hub and do not cancel', () => {
  const options = parseArgsForSmoke([]);
  assert.match(options.hub, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(options.cancel, false);
  assert.equal(options.timeoutSeconds, 300);
});

test('a trailing slash on the hub is removed', () => {
  assert.equal(parseArgsForSmoke(['--hub', 'http://127.0.0.1:3081/']).hub, 'http://127.0.0.1:3081');
});

test('cancel mode is selected by --cancel', () => {
  assert.equal(parseArgsForSmoke(['--cancel']).cancel, true);
});

test('a bad timeout or an unknown flag is refused, not defaulted', () => {
  assert.throws(() => parseArgsForSmoke(['--timeout', 'soon']), /--timeout must be a positive integer/);
  assert.throws(() => parseArgsForSmoke(['--timeout', '0']), /--timeout must be a positive integer/);
  assert.throws(() => parseArgsForSmoke(['--wat']), /unknown argument --wat/);
  assert.throws(() => parseArgsForSmoke(['--hub']), /--hub needs a value/);
});

test('the documented exit codes are reachable', () => {
  const script = fileURLToPath(new URL('../scripts/smoke-hub.mjs', import.meta.url));
  const badArgs = spawnSync(process.execPath, [script, '--timeout', 'soon'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(badArgs.status, 2, `bad arguments must exit 2, got ${badArgs.status}: ${badArgs.stderr}`);
  // Port 1 on loopback refuses instantly; the probe must report an unreachable
  // hub (3), not a failed job (1) or a crash.
  const deadHub = spawnSync(process.execPath, [script, '--hub', 'http://127.0.0.1:1'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(deadHub.status, 3, `an unreachable hub must exit 3, got ${deadHub.status}: ${deadHub.stderr}`);
  assert.match(deadHub.stderr, /hub unreachable/);
});
