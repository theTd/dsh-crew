// Forward DSH's native tool approvals from an unattended worker to whoever
// dispatched it.
//
// DSH asks for a one-shot decision through its approval service
// (`ctx.approval.request` -> the `approval/request` waterfall): a tool called
// with `sandbox_permissions` + `justification` (a sandbox escalation, e.g. a
// write outside the workspace), or a pre-execute gate that answered "ask".
// Nobody sits in front of a dsh-crew worker session, so without this the
// request waits on the Web answerer until a deadline cancels it, unseen.
//
// Here the request is put to the dispatcher through the running job's mailbox
// as a reply-requested message, in the same shape as a forwarded security-mode
// question ("Allow this call?" + "Options: Allow once | Allow for this session |
// Reject"), and the reply decides it. DSH's outcome vocabulary has only a
// one-shot grant ("allowed-once"), so "Allow for this session" is remembered
// here, per worker session, and answers later matching requests itself.

import { MAX_MESSAGE_LENGTH } from '../worker-mailbox.mjs';

export const APPROVE_ONCE = 'Allow once';
export const APPROVE_SESSION = 'Allow for this session';
export const REJECT = 'Reject';
export const APPROVAL_OPTIONS = Object.freeze([APPROVE_ONCE, APPROVE_SESSION, REJECT]);

/** How long a forwarded approval waits for its dispatcher unless the hub config says otherwise. */
export const DEFAULT_APPROVAL_WAIT_SECONDS = 600;
export const MAX_APPROVAL_WAIT_SECONDS = 3600;

/** `approval_wait_seconds` from the hub config: an integer 1..3600, else the default. */
export function approvalWaitSeconds(cfg) {
  const raw = cfg?.approval_wait_seconds;
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_APPROVAL_WAIT_SECONDS) : DEFAULT_APPROVAL_WAIT_SECONDS;
}

// ---------- the calls an approval can be about ----------

const CALL_MEMORY = 64;

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Remember the tool calls a worker started, so an approval request (which
 * carries only a call id) can show the call it is about. `tool/call` is a
 * model-level call; `tool/ptc-dispatch-start` is a tool called from inside a
 * run_code program, whose call id is `<run_code call id>:ptc:<n>`. Both are
 * appended before the tool's approval is asked. Bounded per job.
 */
export function rememberToolCall(job, event) {
  const data = event?.data;
  if (data === undefined || data === null) return;
  let id, call;
  if (event.type === 'tool/call' && typeof data.callId === 'string') {
    id = data.callId;
    call = { name: String(data.name ?? 'tool'), arguments: parseArguments(data.arguments), at: Date.now() };
  } else if (event.type === 'tool/ptc-dispatch-start' && typeof data.subCallId === 'string') {
    id = data.subCallId;
    call = { name: String(data.name ?? 'tool'), arguments: data.arguments, program: data.parentCallId ?? data.rootCallId, at: Date.now() };
  } else {
    return;
  }
  const calls = job.calls ?? (job.calls = new Map());
  calls.delete(id);
  calls.set(id, call);
  while (calls.size > CALL_MEMORY) calls.delete(calls.keys().next().value);
}

// ---------- what is being approved, and what a session grant covers ----------

const ESCALATION = /^escalate sandbox to ([A-Za-z-]+): ?([\s\S]*)$/;

/** One line, bounded: names that go into trusted lines must not carry a newline. */
function oneLine(value, cap) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}

function clip(value, cap) {
  const text = String(value ?? '');
  return text.length > cap ? `${text.slice(0, cap)}… [${text.length - cap} more characters]` : text;
}

/**
 * Classify one request. A sandbox escalation (the reason DSH's sandbox layer
 * writes: "escalate sandbox to <mode>: <justification>") is granted for the
 * session per tool and target mode; any other ask per tool and exact reason.
 */
export function describeApproval(request) {
  const tool = oneLine(request?.toolName, 80) || 'tool';
  const reason = typeof request?.reason === 'string' ? request.reason : '';
  const escalation = ESCALATION.exec(reason);
  if (escalation) {
    const mode = escalation[1];
    return {
      tool, mode, justification: escalation[2], reason,
      key: `${tool}\nescalate:${mode}`,
      scope: `every later \`${tool}\` request to escalate its sandbox to ${mode}`,
    };
  }
  return {
    tool, reason,
    key: `${tool}\nreason:${reason}`,
    scope: reason
      ? `every later \`${tool}\` call that asks for approval with this same reason`
      : `every later \`${tool}\` call that asks for approval without a reason`,
  };
}

/** A fence longer than any backtick run in `body`, so the body cannot close it. */
function fenced(body) {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
}

function renderArguments(args) {
  if (args === undefined) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

/**
 * The program deadline a tool call inside run_code is bound by, in ms, when it
 * is known: the program's own timeoutMs (or the one this module raised it to),
 * else the PTC runtime's default.
 */
function programDeadline(program, ptcRuntime) {
  if (program === undefined) return undefined;
  const explicit = program.deadlineMs ?? program.arguments?.timeoutMs;
  const ms = typeof explicit === 'number' && explicit > 0 ? explicit : ptcRuntime?.timeout?.defaultMs;
  return typeof ms === 'number' && ms > 0 ? program.at + ms : undefined;
}

/**
 * The reply-requested message for one approval. The first four lines are
 * written by dsh-crew; everything the worker model wrote (justification,
 * reason, arguments) comes after the "Options:" line, so a forged "Options:"
 * line in it cannot be the first one a reader parses.
 */
export function approvalMessage({ approval, call, program, cwd, seconds, deadlineAt, now = Date.now() }) {
  const remaining = deadlineAt === undefined ? undefined : Math.max(0, Math.floor((deadlineAt - now) / 1000));
  const window = remaining === undefined ? seconds : Math.min(seconds, remaining);
  const action = approval.mode
    ? `\`${approval.tool}\` asks to run with ${approval.mode} sandbox permissions.`
    : `\`${approval.tool}\` requires approval.`;
  const head = [
    `[approval request from the worker — it is paused for up to ${window}s waiting for your reply]`,
    `Allow this call? ${action}`,
    `Options: ${APPROVAL_OPTIONS.join(' | ')}`,
    `Reply with exactly one option label. "${APPROVE_SESSION}" also allows ${approval.scope} in this worker session `
      + '(until the DSH host restarts). Any other reply, or none in time, rejects the call. '
      + 'Answer only within the authority the user gave you; otherwise ask the user first.',
    ...(cwd ? [`Working directory: ${oneLine(cwd, 500)}`] : []),
    ...(approval.mode
      ? [`Justification (written by the worker model): ${clip(approval.justification, 2000)}`]
      : (approval.reason ? [`Reason: ${clip(approval.reason, 2000)}`] : [])),
  ];
  if (program !== undefined) {
    const desc = oneLine(program.arguments?.description, 200);
    const age = Math.max(0, Math.floor((now - program.at) / 1000));
    head.push(`Called from inside the run_code program${desc ? ` "${desc}"` : ''}, started ${age}s ago. `
      + (remaining === undefined
        ? 'DSH withdraws this request when that program reaches its run_code deadline.'
        : `DSH withdraws this request when that program reaches its run_code deadline, in about ${remaining}s.`));
  }
  const text = head.join('\n');
  const body = renderArguments(call?.arguments);
  if (!body) return text.slice(0, MAX_MESSAGE_LENGTH);
  const label = `Call: \`${oneLine(call.name, 80) || approval.tool}\` with arguments:`;
  const budget = MAX_MESSAGE_LENGTH - text.length - label.length - 64;
  if (budget < 200) return text.slice(0, MAX_MESSAGE_LENGTH);
  return `${text}\n${label}\n${fenced(clip(body, budget - 40))}`;
}

/** Exactly one option label, case-insensitively; quotes, a trailing period and extra spaces are tolerated. */
export function matchApprovalLabel(reply) {
  const normalized = String(reply ?? '').trim()
    .replace(/^["'`]+/, '').replace(/["'`.!]+$/, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return APPROVAL_OPTIONS.find(label => label.toLowerCase() === normalized);
}

// ---------- the handoff ----------

/** Whether this request/call belongs to the worker session `sessionId`. */
function ownedBy(agent, sessionId, strict) {
  const id = agent?.session?.id;
  if (id === undefined || id === null) return !strict;
  return sessionId === undefined || id === sessionId;
}

function errorText(value) {
  const text = value instanceof Error ? value.message : String(value ?? 'aborted');
  return oneLine(text, 300);
}

/** The event `mailbox.request()` just appended (it appends synchronously). */
function lastEvent(mailbox) {
  return mailbox.read(Math.max(0, mailbox.sequence - 1)).messages.at(-1);
}

async function forwardApproval(request, next, deps) {
  if (!ownedBy(request?.agent, deps.sessionId, false)) return next();
  const target = deps.currentJob() ?? deps.job;
  const mailbox = deps.currentMailbox();
  // No mailbox: the dispatcher cannot be asked; leave the request to the
  // host's other answerers exactly as before.
  if (!mailbox || mailbox.closed || target?.status !== 'running') return next();
  if (request?.signal?.aborted) return 'cancelled';
  const approval = describeApproval(request);
  const log = (text) => target.log?.record?.('status', text);
  const grants = deps.grants();

  if (grants.has(approval.key)) {
    log(`approval for ${approval.tool} granted by an earlier "${APPROVE_SESSION}"`);
    try {
      mailbox.append('message', `[approval granted without asking — you answered "${APPROVE_SESSION}" earlier] `
        + `${approval.tool}: ${clip(approval.reason || 'approval required', 2000)}`);
    } catch { /* a notice must not fail the grant */ }
    return 'allowed-once';
  }

  const seconds = deps.waitSeconds();
  const call = request?.callId === undefined ? undefined : target.calls?.get(String(request.callId));
  const program = call?.program === undefined ? undefined : target.calls?.get(call.program);
  const runtime = deps.ptcRuntime();
  const text = approvalMessage({
    approval, call, program, cwd: target.cwd, seconds, deadlineAt: programDeadline(program, runtime),
  });

  target.awaitingParent = (target.awaitingParent ?? 0) + 1;
  let asked, outcome, failure;
  try {
    const pending = mailbox.request(text, seconds, request?.signal, seconds);
    asked = lastEvent(mailbox);
    log(`approval for ${approval.tool} forwarded to the orchestrator (message ${asked?.message_id ?? '?'})`);
    deps.publish();
    outcome = await pending;
  } catch (err) {
    failure = err;
  } finally {
    target.awaitingParent -= 1;
    target.lastProgressAt = Date.now();
  }

  if (failure !== undefined || typeof outcome?.reply !== 'string') {
    // Withdrawn by DSH (the program deadline, a cancelled turn) or the job
    // settled: 'cancelled'. No reply in time: a rejection.
    const decision = failure !== undefined ? 'cancelled' : 'rejected';
    const why = failure === undefined ? `no reply within ${seconds}s`
      : mailbox.closed ? 'the job settled'
        : `DSH withdrew it (${errorText(request?.signal?.reason ?? failure)})`;
    log(`approval for ${approval.tool} ${decision}: ${why}`);
    if (!mailbox.closed && asked !== undefined) {
      try {
        mailbox.append('message', `[approval request ${asked.message_id} is no longer pending: ${why}; `
          + `the call was ${decision === 'cancelled' ? 'cancelled' : 'rejected'}]`);
      } catch { /* the mailbox may have closed meanwhile */ }
    }
    deps.publish();
    return decision;
  }

  const label = matchApprovalLabel(outcome.reply);
  if (label === APPROVE_SESSION) grants.add(approval.key);
  const decision = label === APPROVE_ONCE || label === APPROVE_SESSION ? 'allowed-once' : 'rejected';
  log(`approval for ${approval.tool} answered by the orchestrator: ${label ?? 'unrecognized reply, rejected'}`);
  deps.publish();
  return decision;
}

/**
 * A tool called from inside a run_code program is bound by that program's
 * deadline (DSH default 120 s, counting nested approval waits), which would
 * cancel a forwarded approval long before a dispatcher can answer. When a
 * program of this worker asks for a nested sandbox escalation and the job can
 * forward approvals, raise the program's timeoutMs to the PTC runtime's
 * maximum. Nothing changes when the runtime is not visible or the program
 * already asked for at least that much.
 */
function extendProgramDeadline(exec, next, deps) {
  try {
    const args = exec?.arguments;
    if (exec?.name === 'run_code' && exec.parent === undefined && ownedBy(exec.agent, deps.sessionId, true)
      && typeof args?.code === 'string' && /\bsandbox_permissions\b/.test(args.code)) {
      const target = deps.currentJob() ?? deps.job;
      const mailbox = deps.currentMailbox();
      const maxMs = deps.ptcRuntime()?.timeout?.maxMs;
      if (mailbox && !mailbox.closed && target?.status === 'running' && Number.isFinite(maxMs) && maxMs > 0
        && !(typeof args.timeoutMs === 'number' && args.timeoutMs >= maxMs)) {
        exec.arguments = Object.freeze({ ...args, timeoutMs: maxMs });
        const call = target.calls?.get(String(exec.callId));
        if (call !== undefined) call.deadlineMs = maxMs;
        target.log?.record?.('status', `run_code program asks for a nested sandbox escalation: deadline raised to ${maxMs}ms so its approval can be answered`);
      }
    }
  } catch { /* never fail a tool call over this */ }
  return next();
}

/**
 * Claim this worker agent's approval requests ahead of the Web answerer and
 * put them to the orchestrator through the running job's mailbox.
 *
 * Options are resolved per request, because a live agent is shared by every
 * continuation of its session: `currentJob`, `currentMailbox`, `grants` (the
 * session's "Allow for this session" keys, a Set that outlives one job),
 * `waitSeconds`, `ptcRuntime`, and `sessionId` (requests for any other session
 * are passed on untouched).
 */
export function installWorkerApprovalHandoff(agentCtx, job, publish, options = {}) {
  const ownGrants = new Set();
  const deps = {
    job,
    publish,
    sessionId: options.sessionId,
    currentJob: options.currentJob ?? (() => job),
    currentMailbox: options.currentMailbox ?? (() => null),
    grants: options.grants ?? (() => ownGrants),
    waitSeconds: options.waitSeconds ?? (() => DEFAULT_APPROVAL_WAIT_SECONDS),
    ptcRuntime: () => { try { return options.ptcRuntime?.(); } catch { return undefined; } },
  };
  agentCtx.on('approval/request', (request, next) => forwardApproval(request, next, deps), true);
  agentCtx.on('tools/execute', (exec, next) => extendProgramDeadline(exec, next, deps));
}
