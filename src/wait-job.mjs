#!/usr/bin/env node
// wait-job — block in a shell until one DSH worker job settles, or until the
// worker sends its parent a message.
//
// One command instead of a polling loop: a dispatcher starts the worker, hands
// the job id to a background shell, and spends no tokens while it waits. The
// exit code is the contract, and the last two lines are a footer plus the same
// `crew_job:` line every job tool returns.
//
//   node src/wait-job.mjs <job-id> [--hub URL] [--deadline-min 110]
//                        [--interval-seconds 60] [--retries 5] [--retry-delay-seconds 5]
//                        [--after N]
//
// Exit codes:
//   0  done               1  failed / cancelled / timeout
//   2  needs_input        3  still running at the deadline (run again)
//   4  hub unreachable, job unknown, or no status ever observed
//   5  a worker message is waiting for the parent
//  64  bad usage
//
// The MCP session that spawned the job leaves its private mailbox token in
// <crew state>/tokens/<job-id>. While that file exists, each cycle long-polls
// the mailbox first: a new worker message prints one `worker_message: {...}`
// line and exits 5, with a wait_command that resumes from `--after
// <next_cursor>` so the dispatcher can relay the message and keep waiting.
// Completion events never do that — they fall through to the status check.
// Without a token file, or when the mailbox read is denied or errors, this is
// the status-only wait it has always been.
//
// Exit 4 never invents a state: without an observation the block says
// `"status":"unknown"`.

import { crewBlock, crewFooter } from './crew-block.mjs';
import { logPathFor } from './job-log.mjs';
import { readJobToken } from './job-token-store.mjs';

const DEFAULT_HUB = 'http://127.0.0.1:3080';
const SETTLED = new Set(['done', 'failed', 'cancelled', 'timeout', 'needs_input']);
const MAX_MAILBOX_WAIT_SECONDS = 30;

export function parseWaitArgs(argv) {
  const out = {
    hub: process.env.DSHPLUGIN_CREW_HUB ?? DEFAULT_HUB,
    deadlineMinutes: 110,
    intervalSeconds: 60,
    retries: 5,
    retryDelaySeconds: 5,
    after: 0,
    jobId: undefined,
  };
  const value = (at, flag) => {
    const next = argv[at];
    if (next === undefined) throw new Error(`wait-job: ${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--hub') out.hub = value(i += 1, arg).replace(/\/$/, '');
    else if (arg === '--deadline-min') out.deadlineMinutes = Number(value(i += 1, arg));
    else if (arg === '--interval-seconds') out.intervalSeconds = Number(value(i += 1, arg));
    else if (arg === '--retries') out.retries = Number(value(i += 1, arg));
    else if (arg === '--retry-delay-seconds') out.retryDelaySeconds = Number(value(i += 1, arg));
    else if (arg === '--after') out.after = Number(value(i += 1, arg));
    else if (arg.startsWith('-')) throw new Error(`wait-job: unknown argument ${arg}`);
    else if (out.jobId === undefined) out.jobId = arg;
    else throw new Error(`wait-job: unexpected extra argument ${arg}`);
  }
  if (out.help) return out;
  if (out.jobId === undefined) throw new Error('wait-job: a job id is required');
  if (!Number.isFinite(out.deadlineMinutes) || out.deadlineMinutes < 0) throw new Error('wait-job: --deadline-min must be a non-negative number');
  if (!Number.isFinite(out.intervalSeconds) || out.intervalSeconds <= 0) throw new Error('wait-job: --interval-seconds must be positive');
  if (!Number.isInteger(out.retries) || out.retries < 1) throw new Error('wait-job: --retries must be an integer >= 1');
  if (!Number.isFinite(out.retryDelaySeconds) || out.retryDelaySeconds < 0) throw new Error('wait-job: --retry-delay-seconds must be non-negative');
  if (!Number.isInteger(out.after) || out.after < 0) throw new Error('wait-job: --after must be a non-negative integer');
  return out;
}

function printBlock(job, options = {}) {
  const block = crewBlock(job, options);
  const final = options.error === undefined ? block : { ...block, error: options.error };
  console.log(crewFooter(final));
  console.log(`crew_job: ${JSON.stringify(final)}`);
}

/** A bad id must not crash the CLI before it prints the block. */
function safeLogPath(id) {
  try {
    return logPathFor(id);
  } catch {
    return null;
  }
}

function exitCodeFor(status) {
  if (status === 'done') return 0;
  if (status === 'failed' || status === 'cancelled' || status === 'timeout') return 1;
  if (status === 'needs_input') return 2;
  if (status === 'running') return 3;
  return 4;
}

async function fetchJob(options, waitSeconds) {
  const response = await fetch(
    `${options.hub}/_dsh/dsh-crew/jobs/${encodeURIComponent(options.jobId)}?wait=${waitSeconds}`,
    { signal: AbortSignal.timeout((waitSeconds + 10) * 1000) },
  );
  if (response.status === 404) return { missing: true };
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  const body = await response.json();
  return { job: body.job };
}

/**
 * One mailbox long-poll. A non-ok answer (wrong/stale token, a hub too old for
 * the route, a non-messaging job) is an expected refusal, not a network
 * failure: the caller falls back to status-only waiting. Only a thrown fetch is
 * a network error.
 */
async function fetchMailbox(options, token, waitSeconds) {
  const response = await fetch(
    `${options.hub}/_dsh/dsh-crew/jobs/${encodeURIComponent(options.jobId)}/messages`
      + `?after=${options.after}&wait=${waitSeconds}`,
    {
      headers: { 'x-dsh-crew-job-token': token },
      signal: AbortSignal.timeout((waitSeconds + 10) * 1000),
    },
  );
  if (!response.ok) return { refused: true };
  const body = await response.json();
  const result = body?.result;
  if (!result || !Array.isArray(result.messages)) return { refused: true };
  return { result };
}

/** Worker messages the dispatcher has not relayed yet. Completion never counts. */
function pendingWorkerMessages(result, after) {
  return (result?.messages ?? []).filter(
    (event) => event?.kind === 'message' && Number(event.sequence) > after,
  );
}

/** Resume position for the next wait; the hub's next_cursor wins when sane. */
function nextCursorFor(result, after, events) {
  const cursor = result?.next_cursor;
  if (Number.isInteger(cursor) && cursor > after) return cursor;
  return events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), after);
}

/** The one line a dispatcher copies into its wake-up report. */
function printWorkerMessage(event) {
  console.log(`worker_message: ${JSON.stringify({
    message_id: event.message_id ?? null,
    text: event.text ?? '',
    expects_reply: event.expects_reply === true,
    created_at: event.created_at ?? null,
  })}`);
}

async function main() {
  let options;
  try {
    options = parseWaitArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? String(err));
    return 64;
  }
  if (options.help) {
    console.log('usage: node src/wait-job.mjs <job-id> [--hub URL] [--deadline-min 110] [--interval-seconds 60] [--retries 5] [--retry-delay-seconds 5] [--after N]');
    return 0;
  }

  const deadline = Date.now() + options.deadlineMinutes * 60_000;
  let last;
  let unreachable = 0;
  for (;;) {
    const remainingSeconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    // Read the token every cycle: the MCP server deletes it once it observes
    // the job settled, and a stale file must never keep the waiter on a dead
    // mailbox.
    const token = readJobToken(options.jobId);
    let mailbox;
    if (token !== null) {
      const mailboxWait = Math.max(0, Math.min(MAX_MAILBOX_WAIT_SECONDS, options.intervalSeconds, remainingSeconds));
      try {
        mailbox = await fetchMailbox(options, token, mailboxWait);
      } catch (err) {
        // A mailbox network failure is the hub failing, exactly like a status
        // read: the same retry budget and the same exit 4.
        unreachable += 1;
        if (unreachable >= options.retries) {
          const blockJob = last ?? { id: options.jobId, status: 'unknown', model: null };
          printBlock(blockJob, { logPath: safeLogPath(options.jobId), error: `hub unreachable at ${options.hub}: ${err?.message ?? err}` });
          return 4;
        }
        if (options.retryDelaySeconds > 0) await new Promise((done) => setTimeout(done, options.retryDelaySeconds * 1000));
        continue;
      }
    }
    // With a usable mailbox the long-poll above was this cycle's wait, so the
    // status read is immediate. A refused/malformed mailbox read falls back to
    // today's status-only wait, server-side wait included.
    const mailboxUsable = mailbox?.result !== undefined;
    const statusWait = mailboxUsable ? 0 : Math.min(options.intervalSeconds, remainingSeconds, 600);
    try {
      const result = await fetchJob(options, statusWait);
      unreachable = 0;
      if (result.missing) {
        printBlock({ id: options.jobId, status: 'unknown', model: null }, {
          logPath: safeLogPath(options.jobId), error: 'no such job on this hub',
        });
        return 4;
      }
      last = result.job;
      const events = pendingWorkerMessages(mailbox?.result, options.after);
      if (events.length > 0) {
        for (const event of events) printWorkerMessage(event);
        printBlock(last, {
          logPath: safeLogPath(options.jobId),
          after: nextCursorFor(mailbox.result, options.after, events),
        });
        return 5;
      }
      if (SETTLED.has(last.status)) {
        printBlock(last, { logPath: safeLogPath(options.jobId) });
        return exitCodeFor(last.status);
      }
      if (Date.now() >= deadline) {
        printBlock(last, { logPath: safeLogPath(options.jobId), error: 'deadline reached while the job was still running' });
        return 3;
      }
    } catch (err) {
      unreachable += 1;
      if (unreachable >= options.retries) {
        const blockJob = last ?? { id: options.jobId, status: 'unknown', model: null };
        printBlock(blockJob, { logPath: safeLogPath(options.jobId), error: `hub unreachable at ${options.hub}: ${err?.message ?? err}` });
        return 4;
      }
      if (options.retryDelaySeconds > 0) await new Promise((done) => setTimeout(done, options.retryDelaySeconds * 1000));
      continue;
    }
    if (options.intervalSeconds > 0) await new Promise((done) => setTimeout(done, 0));
  }
}

if (process.argv[1] && process.argv[1].endsWith('wait-job.mjs')) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`wait-job: ${err?.message ?? err}`);
    process.exit(1);
  });
}
