// Per-job token handoff (src/job-token-store.mjs).
//
// The MCP server writes the token, a separate `wait-job` process reads it, and
// the server deletes it when the job settles. Every function here resolves the
// state root per call, so each test runs against its own temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  TOKEN_MAX_AGE_MS,
  deleteJobToken,
  jobTokenExists,
  pruneJobTokens,
  readJobToken,
  sanitizeJobId,
  tokenFilePathFor,
  tokensDir,
  writeJobToken,
} from '../src/job-token-store.mjs';

function withStateRoot(fn) {
  const previous = process.env.DSHPLUGIN_CREW_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'crew-token-store-'));
  process.env.DSHPLUGIN_CREW_CONFIG_DIR = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.DSHPLUGIN_CREW_CONFIG_DIR;
    else process.env.DSHPLUGIN_CREW_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test('a token round-trips and is scoped to one job', () => {
  withStateRoot(() => {
    assert.equal(writeJobToken('hub-1-a', 'tok-a'), true);
    assert.equal(readJobToken('hub-1-a'), 'tok-a');
    assert.equal(readJobToken('hub-1-b'), null);
    assert.equal(jobTokenExists('hub-1-a'), true);
    assert.equal(tokenFilePathFor('hub-1-a'), join(tokensDir(), 'hub-1-a'));

    assert.equal(deleteJobToken('hub-1-a'), true);
    assert.equal(readJobToken('hub-1-a'), null);
    assert.equal(jobTokenExists('hub-1-a'), false);
    assert.equal(deleteJobToken('hub-1-a'), false, 'a missing file is not an error');
  });
});

test('job ids become safe file names inside the tokens folder', () => {
  withStateRoot(() => {
    assert.equal(sanitizeJobId('a/b c'), 'a_b_c');
    assert.equal(sanitizeJobId('..'), '_');
    assert.equal(sanitizeJobId('.hidden'), '_hidden');
    const file = tokenFilePathFor('../escape');
    assert.ok(file.startsWith(tokensDir() + sep), 'a traversal-looking id stays inside the tokens folder');
    assert.equal(writeJobToken('../escape', 'tok'), true);
    assert.equal(readJobToken('../escape'), 'tok');
  });
});

test('a malformed token file reads as absent instead of throwing', () => {
  withStateRoot(() => {
    mkdirSync(tokensDir(), { recursive: true });
    writeFileSync(tokenFilePathFor('hub-2-bad'), 'not json');
    assert.equal(readJobToken('hub-2-bad'), null);
    writeFileSync(tokenFilePathFor('hub-2-other'), JSON.stringify({ job_id: 'hub-2-foreign', token: 'x' }));
    assert.equal(readJobToken('hub-2-other'), null, 'a file written for another job is ignored');
  });
});

test('a normal process exit removes the token files that process wrote', () => {
  withStateRoot((root) => {
    const store = fileURLToPath(new URL('../src/job-token-store.mjs', import.meta.url));
    const code = `import { writeJobToken } from ${JSON.stringify(pathToFileURL(store).href)}; writeJobToken('hub-exit', 'tok');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, DSHPLUGIN_CREW_CONFIG_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'tokens', 'hub-exit')), false, 'the exit hook removes the token');
  });
});

test('pruning removes token files older than 24 h and keeps fresh ones', () => {
  withStateRoot(() => {
    assert.equal(writeJobToken('fresh', 't-fresh'), true);
    assert.equal(writeJobToken('stale', 't-stale'), true);
    const old = new Date(Date.now() - TOKEN_MAX_AGE_MS - 60_000);
    utimesSync(tokenFilePathFor('stale'), old, old);

    assert.equal(pruneJobTokens(), 1);
    assert.equal(existsSync(tokenFilePathFor('stale')), false);
    assert.equal(readJobToken('fresh'), 't-fresh');
    assert.equal(pruneJobTokens(), 0, 'nothing old is left to prune');
  });
});
