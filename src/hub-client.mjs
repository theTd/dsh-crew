// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { pluginEnv } from './plugin-env.mjs';
import { randomUUID } from 'node:crypto';
import { writeJobToken } from './job-token-store.mjs';

const BASE = (pluginEnv('CREW_HUB') ?? readGlobalConfig().hub_url).replace(/\/$/, '');
const API = `${BASE}/_dsh/dsh-crew`;
const messagingTokens = new Map();

/**
 * A fresh per-job token, in the one format both spawn and continue send: the
 * MCP client owns the token, the hub only ever sees it, and the background
 * waiter gets it through the token file below. WorkerMailbox accepts 32–128
 * characters; a UUID is 36.
 */
function mintMessagingToken() {
  return randomUUID();
}

/**
 * Remember a job this session can message, and hand the token to the
 * background `wait-job` process. Best effort: a token file that cannot be
 * written only means that waiter stays status-only.
 */
function rememberMessagingJob(job, token) {
  messagingTokens.set(job.id, token);
  writeJobToken(job.id, token);
}

function messageHeaders(jobId) {
  const token = messagingTokens.get(jobId);
  if (!token) throw new Error('this MCP session does not own messaging for that job');
  return { 'content-type': 'application/json', 'x-dsh-crew-job-token': token };
}

let lastProbe = { at: 0, ok: false };

export async function hubAvailable() {
  if (Date.now() - lastProbe.at < 10_000) return lastProbe.ok;
  try {
    const res = await fetch(`${API}/ping`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    lastProbe = { at: Date.now(), ok: res.ok && body?.service === 'dsh-crew-hub' };
  } catch {
    lastProbe = { at: Date.now(), ok: false };
  }
  return lastProbe.ok;
}

async function call(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `hub request failed (${res.status})`);
  return body;
}

/**
 * One long-poll may never outlive the runtime's request timeouts. Node's
 * fetch (undici) aborts a request whose response headers have not arrived
 * within 300 s, and the hub sends nothing until the job settles — so a
 * `?wait=2700` poll dies at five minutes with a bare "fetch failed" while the
 * job keeps running server-side. Measured on 2026-08-19: dispatches of 2 s and
 * 4 m 03 s returned normally; 14 m, 22 m, 35 m and 41 m all failed that way.
 * Slicing the wait keeps every individual request short enough that no
 * runtime, proxy or load balancer can cut it.
 */
const MAX_POLL_SLICE_SECONDS = 30;

export const hub = {
  probe: (binding) => call('/worker-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(binding) }).then(b => b.result),
  spawn: async (spec) => {
    const token = mintMessagingToken();
    const { job } = await call('/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spec, messaging_token: token }),
    });
    rememberMessagingJob(job, token);
    return job;
  },
  message: (id, message, replyTo) => call(`/jobs/${encodeURIComponent(id)}/messages`, {
    method: 'POST', headers: messageHeaders(id), body: JSON.stringify({ message, reply_to: replyTo }),
  }).then(body => body.result),
  messages: (id, after = 0, wait = 0, signal) => call(`/jobs/${encodeURIComponent(id)}/messages?after=${after}&wait=${wait}`, {
    headers: messageHeaders(id), signal,
  }).then(body => body.result),
  list: () => call('/jobs').then((b) => b.jobs),
  // A continued job is messaging-enabled exactly like a spawned one: mint the
  // token here, send it with the request, remember it for `dsh_worker_message`
  // and write it for the background waiter. A hub too old to read the field
  // ignores it; the job still runs and the waiter falls back to status-only.
  continueJob: async (id, text, timeoutSeconds) => {
    const token = mintMessagingToken();
    const { job } = await call(`/jobs/${encodeURIComponent(id)}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        messaging_token: token,
        ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
      }),
    });
    rememberMessagingJob(job, token);
    return job;
  },
  // The LLM routes the HOST has configured. Only the hub can answer this: the
  // MCP server is a separate process with no ctx.llm. Returns [] rather than
  // throwing when the hub is too old to serve the route, so a stale hub
  // degrades to "cannot enumerate" instead of breaking the config tool.
  providers: () => call('/providers').then((b) => ({
    providers: b.providers ?? [],
    bindings: b.bindings ?? null,
  })).catch(() => ({ providers: [], bindings: null })),
  // `waitSeconds = 0` keeps the plain "read it now" semantics; anything longer
  // is served by repeated short waits until the job settles or the budget ends.
  get: async (id, waitSeconds = 0) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const slice = waitSeconds <= 0 ? 0 : Math.max(1, Math.min(MAX_POLL_SLICE_SECONDS, remaining));
      const job = await call(`/jobs/${id}?wait=${slice}`).then((b) => b.job);
      if (job.status !== 'running' || waitSeconds <= 0 || Date.now() >= deadline) return job;
    }
  },
  cancel: (id) => call(`/jobs/${id}/cancel`, { method: 'POST' }).then((b) => b.job),
};
