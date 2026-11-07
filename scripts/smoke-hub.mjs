#!/usr/bin/env node
// scripts/smoke-hub.mjs — dispatch one real DSH worker through the MCP shim.
//
// This is the M1 acceptance probe: it starts `src/server.mjs` as a stdio MCP
// server against a running dsh-crew hub, spawns one worker, reads its status,
// and either waits for the result or cancels it. It never pretends: a job that
// fails prints the worker's own error and exits non-zero.
//
// Usage:
//   node scripts/smoke-hub.mjs [--hub URL] [--config DIR] [--cwd DIR]
//                              [--timeout SECONDS] [--cancel] [--task TEXT]
//
// Exit codes: 0 pass, 1 the job failed, 2 bad arguments, 3 hub/transport unreachable.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HUB = 'http://127.0.0.1:3081';
const SMOKE_TASK = 'Reply with exactly SMOKE-OK and nothing else. Do not read or write any file.';
const CANCEL_TASK = 'Run this shell command and then reply DONE: Start-Sleep -Seconds 60';

/**
 * Parse the smoke CLI. Exported so the argument paths can be tested without a
 * running hub (tests/smoke-hub.test.mjs).
 *
 * @param argv - arguments after the script name
 * @returns `{ hub, config, cwd, timeoutSeconds, cancel, task }`
 */
export function parseArgsForSmoke(argv) {
  const out = {
    hub: process.env.DSHPLUGIN_CREW_HUB ?? DEFAULT_HUB,
    config: process.env.DSHPLUGIN_CREW_CONFIG_DIR ?? join(ROOT, '.messaging-dev', 'crew-state'),
    cwd: join(ROOT, '.messaging-dev', 'workspace'),
    timeoutSeconds: 300,
    cancel: false,
    task: SMOKE_TASK,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`smoke: ${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--hub') out.hub = value().replace(/\/$/, '');
    else if (arg === '--config') out.config = value();
    else if (arg === '--cwd') out.cwd = value();
    else if (arg === '--task') out.task = value();
    else if (arg === '--timeout') {
      const seconds = Number(value());
      if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('smoke: --timeout must be a positive integer');
      out.timeoutSeconds = seconds;
    } else if (arg === '--cancel') out.cancel = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`smoke: unknown argument ${arg}`);
  }
  return out;
}

function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

function parseJob(body) {
  const raw = String(body ?? '').trim();
  // Job tools append a footer and a `crew_job:` line after the JSON body.
  const cut = raw.indexOf('\n\n[');
  const candidate = cut === -1 ? raw : raw.slice(0, cut);
  try {
    const parsed = JSON.parse(candidate);
    return parsed?.job ?? parsed;
  } catch {
    const line = raw.split('\n').find((entry) => entry.startsWith('crew_job: '));
    if (line !== undefined) {
      try { return JSON.parse(line.slice('crew_job: '.length)); } catch { return undefined; }
    }
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function main() {
  let options;
  try {
    options = parseArgsForSmoke(process.argv.slice(2));
  } catch (err) {
    console.error(err?.message ?? String(err));
    return 2;
  }
  if (options.help) {
    console.log('usage: node scripts/smoke-hub.mjs [--hub URL] [--config DIR] [--cwd DIR] [--timeout SECONDS] [--cancel] [--task TEXT]');
    return 0;
  }
  mkdirSync(options.cwd, { recursive: true });

  // A dead hub is its own exit code: without this probe the MCP server still
  // starts and listTools() succeeds, so the failure would be reported as a
  // failed job (1) and an automation keying on the documented codes would act
  // on the wrong thing.
  const ping = await fetch(`${options.hub}/_dsh/dsh-crew/ping`, { signal: AbortSignal.timeout(5000) })
    .then((response) => response.ok)
    .catch(() => false);
  if (!ping) {
    console.error(`smoke: hub unreachable at ${options.hub}`);
    return 3;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'src', 'server.mjs')],
    env: {
      ...process.env,
      DSHPLUGIN_CREW_HUB: options.hub,
      DSHPLUGIN_CREW_CONFIG_DIR: options.config,
      DSHPLUGIN_CREW_ISOLATED: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dsh-crew-smoke', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.listTools();
  } catch (err) {
    console.error(`smoke: cannot reach the MCP server or the hub at ${options.hub}: ${err?.message ?? err}`);
    await client.close().catch(() => {});
    return 3;
  }

  try {
    const spawned = await client.callTool({
      name: 'dsh_spawn_worker',
      arguments: {
        task: options.cancel ? CANCEL_TASK : options.task,
        tier: 'flash',
        effort: 'off',
        cwd: options.cwd,
      },
    });
    const job = parseJob(textOf(spawned));
    const id = job?.id;
    if (typeof id !== 'string') {
      console.error(`smoke: spawn returned no job id: ${textOf(spawned).slice(0, 500)}`);
      return 1;
    }
    console.log(`job_id: ${id}`);

    if (options.cancel) {
      await sleep(3000);
      await client.callTool({ name: 'dsh_worker_cancel', arguments: { job_id: id } });
      for (let i = 0; i < 10; i += 1) {
        // dsh_worker_status is a rendered view; the JSON job state comes from
        // dsh_worker_result with a zero wait.
        const view = parseJob(textOf(await client.callTool({
          name: 'dsh_worker_result',
          arguments: { job_id: id, wait_seconds: 0 },
        })));
        if (view?.status === 'cancelled') {
          console.log(`status: ${view.status}`);
          console.log('smoke: PASS (cancel)');
          return 0;
        }
        await sleep(500);
      }
      console.error(`smoke: FAIL: job ${id} did not reach cancelled within 5s`);
      return 1;
    }

    const result = await client.callTool({
      name: 'dsh_worker_result',
      arguments: { job_id: id, wait_seconds: Math.min(options.timeoutSeconds, 7200) },
    });
    const view = parseJob(textOf(result));
    const status = view?.status ?? 'unknown';
    console.log(`status: ${status}`);
    if (typeof view?.result === 'string' && view.result.length > 0) {
      console.log(`result: ${view.result.slice(0, 500)}`);
    }
    if (status !== 'done') {
      console.error(`smoke: FAIL: job ${id} is ${status}${view?.error ? `: ${view.error}` : ''}`);
      return 1;
    }
    console.log('smoke: PASS');
    return 0;
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`smoke: FAIL: ${err?.message ?? err}`);
    process.exit(1);
  });
}
