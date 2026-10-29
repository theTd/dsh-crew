// Per-job messaging-token handoff between the MCP session and the background
// wait command.
//
// The hub only accepts a mailbox read with the private token minted when the
// MCP process spawned the job (src/hub-client.mjs keeps it in memory), but the
// wake path runs in a separate `wait-job` process. This module is the one place
// that turns a job id into a token file and back: the MCP server writes the file
// at spawn, `wait-job` reads it for the mailbox long-poll, and the server
// deletes it once it observes the job settled. Files older than 24 h are pruned
// on startup so a crashed session cannot leave tokens behind forever.
//
// The token is a capability: the file is written 0600 (best effort on Windows)
// under <crew state>/tokens/, and its content is never logged.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { crewConfigDir } from './config-paths.mjs';

/** Token files older than this are pruned on MCP startup. */
export const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Folder holding one token file per job under the plugin's state root. */
export function tokensDir() {
  return join(crewConfigDir(), 'tokens');
}

/**
 * A job id becomes a file name. Unlike a log path this is deliberately lossy:
 * the wait command only needs the same file back, never the original id, so
 * anything outside [A-Za-z0-9._-] is replaced instead of rejected. Leading dots
 * are replaced too, so a job id can never choose a hidden or traversal path.
 */
export function sanitizeJobId(jobId) {
  if (typeof jobId !== 'string' || jobId === '') throw new Error('job id is required');
  let safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (safe.length > 120) safe = safe.slice(0, 120);
  return safe;
}

/** One job's token file. Resolved per call so an env override applies. */
export function tokenFilePathFor(jobId) {
  return join(tokensDir(), sanitizeJobId(jobId));
}

/**
 * Persist one job's token for the waiter that outlives this MCP turn.
 * Best effort by design: a dispatch must never fail because its token file
 * could not be written (the waiter then falls back to status-only waiting).
 *
 * @returns true when the file was written.
 */
export function writeJobToken(jobId, token) {
  if (typeof token !== 'string' || token === '') return false;
  try {
    const file = tokenFilePathFor(jobId);
    mkdirSync(tokensDir(), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ job_id: jobId, token, created_at: new Date().toISOString() });
    writeFileSync(file, `${payload}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows: mode is advisory */ }
    sessionTokenFiles.add(file);
    installExitCleanup();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a job's token, or null when there is none / it is unreadable / it
 * belongs to a different job. A malformed file is not repaired here; the
 * waiter simply falls back to the status-only path.
 */
export function readJobToken(jobId) {
  try {
    const file = tokenFilePathFor(jobId);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.job_id !== jobId) return null;
    return typeof parsed?.token === 'string' && parsed.token !== '' ? parsed.token : null;
  } catch {
    return null;
  }
}

/** Remove a job's token file once it is no longer useful. Best effort. */
export function deleteJobToken(jobId) {
  try {
    const file = tokenFilePathFor(jobId);
    unlinkSync(file);
    sessionTokenFiles.delete(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete token files older than `maxAgeMs` (default 24 h). Called once on MCP
 * startup; a crashed session's leftovers disappear on the next one.
 *
 * @returns how many files were removed.
 */
export function pruneJobTokens(maxAgeMs = TOKEN_MAX_AGE_MS, now = Date.now()) {
  let removed = 0;
  let dir;
  try { dir = tokensDir(); } catch { return 0; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(dir, entry.name);
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) {
        unlinkSync(file);
        removed += 1;
      }
    } catch {
      // A file that vanished under us or cannot be statted is left alone.
    }
  }
  return removed;
}

// Tokens written by THIS process, removed when it exits normally. A crash
// leaves them for the 24 h startup prune above.
const sessionTokenFiles = new Set();
let exitHookInstalled = false;

function cleanupSessionTokens() {
  for (const file of sessionTokenFiles) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
  sessionTokenFiles.clear();
}

function installExitCleanup() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', cleanupSessionTokens);
}

/** Test/diagnostic hook: whether a token file exists for this job. */
export function jobTokenExists(jobId) {
  try { return existsSync(tokenFilePathFor(jobId)); } catch { return false; }
}
