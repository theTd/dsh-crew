#!/usr/bin/env node
// Shared QA runner. OWNED BY THE PM — QA reports the line to add, it never
// writes this file. It runs every case under qa/<task-id>/case-*.mjs through the
// project's own test runner, so `npm test` and a by-hand run cannot drift apart.

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const QA = dirname(fileURLToPath(import.meta.url));
const cases = [];
if (existsSync(QA)) {
  for (const entry of readdirSync(QA, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('T-')) continue;
    const dir = join(QA, entry.name);
    for (const file of readdirSync(dir)) {
      if (/^case-.*\.mjs$/.test(file)) cases.push(join(dir, file));
    }
  }
}
if (cases.length === 0) {
  console.log('qa: no cases yet');
  process.exit(0);
}
console.log(`qa: running ${cases.length} case file(s)`);
const run = spawnSync(process.execPath, ['--test', '--test-timeout=30000', '--test-force-exit', ...cases], {
  stdio: 'inherit',
  cwd: resolve(QA, '..'),
});
process.exit(run.status ?? 1);
