import { randomUUID, timingSafeEqual } from 'node:crypto';

export const MAX_MESSAGE_LENGTH = 16_000;
const MAX_EVENTS = 256;

export function messageText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message must be non-empty text of at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  return value;
}

/** Per-job replayable outbox. Reading never consumes another reader's messages. */
export class WorkerMailbox {
  constructor(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      throw new Error('messaging token must contain 32–128 characters');
    }
    this.token = token;
    this.sequence = 0;
    this.events = [];
    this.waiters = new Set();
    this.replies = new Map();
    this.closed = false;
  }

  authorize(token) {
    const candidate = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(this.token);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new Error('messaging access denied for this job');
    }
  }

  append(kind, text, fields = {}) {
    if (this.closed) throw new Error('worker mailbox is closed');
    const event = { ...fields, sequence: ++this.sequence, message_id: randomUUID(), kind,
      text: messageText(text), created_at: new Date().toISOString() };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const wake of this.waiters) wake();
    return event;
  }

  close() {
    this.closed = true;
    for (const wake of this.waiters) wake();
    for (const pending of this.replies.values()) pending.reject(new Error('worker mailbox is closed'));
  }

  request(text, seconds = 60, signal) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 180) {
      throw new Error('reply timeout must be between 1 and 180 seconds');
    }
    if (signal?.aborted) throw signal.reason ?? new Error('reply wait aborted');
    const event = this.append('message', text, { expects_reply: true });
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.replies.delete(event.message_id);
        signal?.removeEventListener('abort', abort);
      };
      const fail = error => { cleanup(); reject(error); };
      const abort = () => fail(signal.reason ?? new Error('reply wait aborted'));
      this.replies.set(event.message_id, {
        resolve: reply => { cleanup(); resolve({ accepted: true, message_id: event.message_id, reply }); },
        reject: fail,
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        cleanup(); resolve({ accepted: true, message_id: event.message_id, timed_out: true });
      }, seconds * 1000);
    });
  }

  reply(messageId, text) {
    messageText(text);
    const pending = this.replies.get(messageId);
    if (!pending) throw new Error('reply target is not pending (it may have expired or already been answered)');
    pending.resolve(text);
  }

  read(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) {
      throw new Error('after must be a non-negative cursor not ahead of the mailbox');
    }
    const first = this.events[0]?.sequence ?? this.sequence + 1;
    return { messages: this.events.filter(event => event.sequence > after),
      next_cursor: this.sequence, has_gap: after < first - 1, closed: this.closed };
  }

  async wait(after, seconds, signal) {
    const initial = this.read(after);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw new Error('wait must be between 0 and 30 seconds');
    if (initial.messages.length || this.closed || seconds === 0) return initial;
    if (signal?.aborted) throw signal.reason ?? new Error('message wait aborted');
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', abort);
      };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason ?? new Error('message wait aborted')); };
      this.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(wake, seconds * 1000);
    });
    return this.read(after);
  }
}

/** A tool scoped to this worker, never a global tool with caller-supplied job ids. */
export function parentMessageTool(mailbox) {
  return {
    name: 'message_parent',
    description: 'Send a progress update or question to your Claude orchestrator. By default returns acceptance '
      + 'and later messages arrive as steering. Set wait_for_reply=true to pause for an explicit answer '
      + '(default 60 seconds, maximum 180); check timed_out before proceeding. This is agent communication, '
      + 'not human permission: use ask_user_question when human approval is required.',
    // Raw ctx.tools.register() preserves this schema; it does not compile the
    // compact parameter DSL accepted by the separate defineTool() helper.
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
        wait_for_reply: { type: 'boolean' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 180 },
      },
      required: ['message'],
      additionalProperties: false,
    },
    timeoutMs: 185_000,
    output: { schema: { type: 'object', properties: {
      message_id: { type: 'string' }, accepted: { type: 'boolean' },
      reply: { type: 'string' }, timed_out: { type: 'boolean' },
    }, required: ['message_id', 'accepted'] },
    render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('message_parent arguments must be an object');
      }
      const allowed = ['message', 'wait_for_reply', 'timeout_seconds'];
      if (Object.keys(args).some(key => !allowed.includes(key))) {
        throw new Error('message_parent received an unknown argument');
      }
      messageText(args.message);
      if ('wait_for_reply' in args && typeof args.wait_for_reply !== 'boolean') {
        throw new Error('wait_for_reply must be a boolean');
      }
      if ('timeout_seconds' in args && (!Number.isInteger(args.timeout_seconds)
        || args.timeout_seconds < 1 || args.timeout_seconds > 180)) {
        throw new Error('timeout_seconds must be an integer between 1 and 180');
      }
      const { message, wait_for_reply = false, timeout_seconds = 60 } = args;
      if (wait_for_reply) return mailbox.request(message, timeout_seconds, exec?.signal);
      const event = mailbox.append('message', message);
      return { accepted: true, message_id: event.message_id };
    },
  };
}
