/** How long a worker waits for its orchestrator to answer before it stops with needs_input. */
export const ORCHESTRATOR_ANSWER_SECONDS = 300;

/**
 * Hand a worker's question to whoever can answer it. Nobody attends a worker
 * session (#13), so the question goes to the orchestrator through the job's
 * mailbox as a reply-requested message. Without a mailbox, without an answer
 * in time, or with more than one question, the worker stops and the question
 * is returned as needs_input.
 *
 * `options.currentJob` and `options.currentMailbox` are resolved per request:
 * a live agent is shared by every continuation of its session, so a listener
 * installed at spawn must act on the job that is running now.
 */
export function installWorkerQuestionHandoff(agentCtx, job, publish, options = {}) {
  const currentJob = options.currentJob ?? (() => job);
  const currentMailbox = options.currentMailbox ?? (() => null);
  const answerSeconds = options.answerSeconds ?? ORCHESTRATOR_ANSWER_SECONDS;
  agentCtx.on('user-questions/request', async (request) => {
    const target = currentJob() ?? job;
    const questions = clipQuestions(request);
    const answer = await askOrchestrator(currentMailbox(), target, questions, request?.signal, answerSeconds, publish);
    if (answer !== undefined) return answer;
    return stopForUser(target, questions, publish);
  }, true);
}

function clipQuestions(request) {
  return Array.isArray(request?.questions) ? request.questions.slice(0, 16).map(q => ({
    id: String(q.id ?? '').slice(0, 200),
    question: String(q.question ?? '').slice(0, 4000),
    ...(typeof q.detail === 'string' ? { detail: q.detail.slice(0, 12000) } : {}),
    ...(Array.isArray(q.options) ? { options: q.options.slice(0, 32).map(o => ({ label: String(o.label ?? '').slice(0, 500) })) } : {}),
  })) : [];
}

/**
 * Post one question to the orchestrator and wait for its reply.
 *
 * @returns an `AskUserQuestionAnswer`, or undefined when nobody answered.
 */
async function askOrchestrator(mailbox, job, questions, signal, seconds, publish) {
  if (!mailbox || mailbox.closed || questions.length !== 1 || job.status !== 'running') return undefined;
  const [question] = questions;
  const labels = (question.options ?? []).map(o => o.label).filter(Boolean);
  job.questions = questions;
  publish();
  let outcome;
  try {
    outcome = await mailbox.request(questionMessage(question, labels, seconds), seconds, signal, seconds);
  } catch {
    outcome = undefined;
  } finally {
    if (job.status === 'running') delete job.questions;
  }
  if (typeof outcome?.reply !== 'string' || job.status !== 'running') return undefined;
  const reply = outcome.reply.trim();
  const label = matchOption(reply, labels);
  job.log?.record?.('status', `question "${question.id}" answered by the orchestrator: ${label ?? 'free text'}`);
  publish();
  return { answers: [label === undefined
    ? { id: question.id, selected: [], custom: reply }
    : { id: question.id, selected: [label] }] };
}

function questionMessage(question, labels, seconds) {
  return [
    `[question from the worker — it is paused for up to ${seconds}s waiting for your reply]`,
    question.question,
    ...(question.detail ? [question.detail] : []),
    ...(labels.length ? [`Options: ${labels.join(' | ')}`] : []),
    'Reply with exactly one option label. Any other text is passed on as a free-text answer, which a '
      + 'security prompt treats as a rejection. Answer only within the authority the user gave you; '
      + 'otherwise ask the user first. No reply in time stops the worker with needs_input.',
  ].join('\n');
}

/** Exact label first, then the longest label the reply starts with, case-insensitively. */
function matchOption(reply, labels) {
  const lower = reply.toLowerCase();
  const exact = labels.find(l => l.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  return [...labels].sort((a, b) => b.length - a.length).find(l => lower.startsWith(l.toLowerCase()));
}

/** Stop an unattended worker and hand its unresolved request back to its caller. */
function stopForUser(job, questions, publish) {
  job.status = 'needs_input';
  job.questions = questions;
  job.result = JSON.stringify({ needs_input: true, questions, instruction: 'Obtain the required answer or approval from the user, then dispatch a new task with that answer. An unanswered question grants no permission.' });
  job.error = 'Worker stopped for an unresolved question; no option was selected automatically.';
  publish();
  // Dispose the runtime, not merely tell the model to stop: it must not run
  // another step after an unanswered overwrite/permission question. Drop the
  // handle as every other dispose path does, so a later continue reloads the
  // session instead of reusing a disposed agent.
  const handle = job.handle;
  job.handle = undefined;
  try { Promise.resolve(handle?.dispose()).catch(() => {}); } catch {}
  const error = new Error(job.error + ' Return the unresolved question to the orchestrator.');
  error.name = 'UserQuestionError'; error.code = 'UNATTENDED_WORKER';
  return Promise.reject(error);
}
