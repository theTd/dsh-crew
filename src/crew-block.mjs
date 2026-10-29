// The machine-readable `crew_job` block and its footer.
//
// A dispatcher shell cannot parse prose. Every job-returning tool ends with one
// JSON line the shell can read, plus a footer a human can read, plus a
// `wait_command` that turns polling into one background command. The shape is
// stable, and `status` keeps this bridge's own states (`needs_input`, `timeout`)
// instead of flattening them.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the wait-job CLI this package ships. */
export const WAIT_JOB_PATH = join(ROOT, 'src', 'wait-job.mjs');

/** Whole seconds from start to finish (or now, while running). */
export function elapsedSeconds(job, now = Date.now()) {
  const start = job?.startedAt ? Date.parse(job.startedAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  const end = job?.endedAt ? Date.parse(job.endedAt) : now;
  return Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
}

/** The one command a dispatcher runs to wait for this job, quoted for a shell. */
export function waitCommand(jobId) {
  return `node "${WAIT_JOB_PATH}" ${jobId}`;
}

/**
 * Build the block body. Unknown optionals are `null`, never omitted, so a
 * reader can rely on the key being present.
 *
 * @param job - a job view (hub or standalone): id, status, model, step, ...
 * @param options - `{ messages, continuedFrom, leaseExpiresAt, logPath }`
 */
export function crewBlock(job, options = {}) {
  // A hub view carries its own ledger; a local view has none and reports zero.
  const counts = options.messages ?? job.messages ?? {};
  return {
    crew: 'dsh',
    job_id: job.id,
    status: job.status,
    session_ref: job.sessionId ?? null,
    model: job.model ?? null,
    step: job.step ?? 0,
    tool_calls: job.toolCalls ?? 0,
    current: job.currentTool ?? null,
    tokens: {
      in: job.tokens?.input ?? 0,
      out: job.tokens?.output ?? 0,
    },
    elapsed_s: elapsedSeconds(job),
    messages: {
      delivered: counts.delivered ?? 0,
      pending: counts.pending ?? 0,
      refused: counts.refused ?? 0,
    },
    continued_from: options.continuedFrom ?? job.continued_from ?? null,
    lease_expires_at: options.leaseExpiresAt ?? job.lease_expires_at ?? null,
    log_path: options.logPath ?? null,
    wait_command: waitCommand(job.id),
  };
}

/** `[dsh | job … | status | model | tokens i/o | tool calls n | 8s | msgs 0 | log …]` */
export function crewFooter(block) {
  const refused = block.messages.refused > 0 ? ` (${block.messages.refused} undelivered)` : '';
  const log = block.log_path === null ? '' : ` | log ${block.log_path}`;
  return `[dsh | job ${block.job_id} | ${block.status} | ${block.model ?? 'unknown'} `
    + `| tokens ${block.tokens.in}/${block.tokens.out} | tool calls ${block.tool_calls} `
    + `| ${block.elapsed_s}s | msgs ${block.messages.delivered}${refused}${log}]`;
}

/** The single machine-readable line every job tool ends with. */
export function crewBlockLine(job, options = {}) {
  return `crew_job: ${JSON.stringify(crewBlock(job, options))}`;
}

/**
 * Append the footer and the block line to a tool's human text.
 *
 * @param body - the text the tool already returns
 * @param job - the job view
 * @param options - see crewBlock
 */
export function withCrewBlock(body, job, options = {}) {
  const block = crewBlock(job, options);
  return `${body}\n\n${crewFooter(block)}\ncrew_job: ${JSON.stringify(block)}`;
}
