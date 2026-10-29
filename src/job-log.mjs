// Per-job event log: a bounded in-memory ring plus one JSONL file per job.
//
// A finished worker leaves nothing but its final text; when it fails halfway,
// the only useful evidence is the sequence of steps and tool calls that led
// there. The hub and the standalone runtime both record here, and the MCP
// process reads the same file — the file is the hand-off, so a log survives the
// process that wrote it and costs no new route.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { crewConfigDir } from './config-paths.mjs';

export const MAX_EVENTS = 200;
export const MAX_SUMMARY = 300;
/** Event kinds a reader may rely on. */
export const KINDS = ['step', 'tool_call', 'tool_result', 'text', 'status', 'message', 'error'];

/** Folder holding one `<job-id>.log` per job under the plugin's state root. */
export function logsDir() {
  return join(crewConfigDir(), 'logs');
}

/**
 * A job id becomes a file name, so it is validated before any path is built.
 * Anything with a separator, a traversal segment or unexpected characters is
 * refused: a caller-controlled `../` must never choose which file is read.
 */
export function assertJobId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(id) || id.includes('..')) {
    throw new Error('invalid job id');
  }
  return id;
}

/** One job's log file. Resolved per call so an env override applies. */
export function logPathFor(id) {
  return join(logsDir(), `${assertJobId(id)}.log`);
}

/** One-line, whitespace-flattened summary with a visible truncation marker. */
export function clip(text, cap = MAX_SUMMARY) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

export class JobLog {
  /** @param id - the job id; also the file name */
  constructor(id) {
    this.id = id;
    this.path = logPathFor(id);
    this.events = [];
  }

  /**
   * Record one event, in memory and on disk.
   *
   * @param kind - one of KINDS
   * @param summary - short human line (clipped to MAX_SUMMARY)
   * @param data - machine fields (tool name, status, counts)
   */
  record(kind, summary, data = {}) {
    const event = { at: new Date().toISOString(), kind, summary: clip(summary), ...data };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    try {
      mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    } catch {
      // A log write must never fail the job it is describing.
    }
    return event;
  }

  /** The last `n` in-memory events (1..MAX_EVENTS). */
  tail(n = 20) {
    return this.events.slice(-Math.max(1, Math.min(n, MAX_EVENTS)));
  }
}

/**
 * Read a job's log from disk, newest-last. Used by the MCP process, which shares
 * the state root with the writer but not its memory.
 *
 * @returns `{ found, path, count, events }`
 */
export function readJobLog(id, tail = 20) {
  const file = logPathFor(id);
  if (!existsSync(file)) return { found: false, path: file, count: 0, events: [] };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const want = Math.max(1, Math.min(tail, MAX_EVENTS));
  const events = lines.slice(-want).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { at: null, kind: 'text', summary: clip(line) };
    }
  });
  return { found: true, path: file, count: lines.length, events };
}
