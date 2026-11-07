// QA T-09: status defaults to this session and caps its size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the status tool scopes by session and caps the response', () => {
  const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
  assert.match(server, /const sessionJobIds = new Set\(\)/);
  assert.match(server, /sessionJobIds\.has\(job\.id\)/);
  assert.match(server, /function capStatusRows\(rows, maxBytes = 8192\)/);
  assert.match(server, /inputSchema: \{ all: z\.boolean\(\)/);
  assert.match(server, /capStatusRows\(\[\.\.\.scoped, \.\.\.locks\]\)/);
});
