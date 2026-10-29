#!/usr/bin/env node
// wait-job — block in a shell until one DSH worker job settles.
//
// One command instead of a polling loop: a dispatcher starts the worker, hands
// the job id to a background shell, and spends no tokens while it waits. The
// exit code is the contract, and the last two lines are a footer plus the same
// `crew_job:` line every job tool returns.
//
//   node src/wait-job.mjs <job-id> [--hub URL] [--deadline-min 110]
//                        [--interval-seconds 60] [--retries 5] [--retry-delay-seconds 5]
//
// Exit codes:
//   0  done               1  failed / cancelled / timeout
//   2  needs_input        3  still running at the deadline (run again)
//   4  hub unreachable, job unknown, or no status ever observed
//  64  bad usage
//
// Exit 4 never invents a state: without an observation the block says
// `"status":"unknown"`.

import { crewBlock, crewFooter } from './crew-block.mjs';
import { logPathFor } from './job-log.mjs';

const DEFAULT_HUB = 'http://127.0.0.1:3080';
const SETTLED = new Set(['done', 'failed', 'cancelled', 'timeout', 'needs_input']);

export function parseWaitArgs(argv) {
  const out = {
    hub: process.env.DSHPLUGIN_CREW_HUB ?? DEFAULT_HUB,
    deadlineMinutes: 110,
    intervalSeconds: 60,
    retries: 5,
    retryDelaySeconds: 5,
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

async function main() {
  let options;
  try {
    options = parseWaitArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? String(err));
    return 64;
  }
  if (options.help) {
    console.log('usage: node src/wait-job.mjs <job-id> [--hub URL] [--deadline-min 110] [--interval-seconds 60] [--retries 5] [--retry-delay-seconds 5]');
    return 0;
  }

  const deadline = Date.now() + options.deadlineMinutes * 60_000;
  let last;
  let unreachable = 0;
  for (;;) {
    const remainingSeconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    const waitSeconds = Math.min(options.intervalSeconds, remainingSeconds, 600);
    try {
      const result = await fetchJob(options, waitSeconds);
      unreachable = 0;
      if (result.missing) {
        printBlock({ id: options.jobId, status: 'unknown', model: null }, {
          logPath: safeLogPath(options.jobId), error: 'no such job on this hub',
        });
        return 4;
      }
      last = result.job;
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
