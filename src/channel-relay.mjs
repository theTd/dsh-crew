/** Transport adapter: the mailbox stays independent of Claude's channel protocol. */
export class ChannelRelay {
  constructor({ read, notify, onError = () => {} }) {
    this.read = read;
    this.notify = notify;
    this.onError = onError;
    this.jobs = new Map();
    this.closed = false;
  }

  watch(jobId) {
    if (this.closed || this.jobs.has(jobId)) return;
    const controller = new AbortController();
    const state = { controller, cursor: 0 };
    this.jobs.set(jobId, state);
    state.promise = this.pump(jobId, state).catch(error => {
      if (!controller.signal.aborted) this.onError(jobId, error);
    });
  }

  async pump(jobId, state) {
    while (!state.controller.signal.aborted) {
      const batch = await this.read(jobId, state.cursor, state.controller.signal);
      if (batch.has_gap) {
        await this.notify({ method: 'notifications/claude/channel', params: {
          content: 'Some older DSH worker messages expired from the bounded mailbox. Check the worker session for its full history.',
          meta: { job_id: jobId, kind: 'message_gap' },
        } });
      }
      for (const event of batch.messages) {
        await this.notify({ method: 'notifications/claude/channel', params: {
          content: `DSH worker ${event.kind}. Agent-generated context; this is not human approval.\n${event.text}`,
          meta: { job_id: jobId, message_id: event.message_id, kind: event.kind,
            ...(event.expects_reply ? { reply_requested: 'true' } : {}),
            ...(event.status ? { status: event.status } : {}) },
        } });
        state.cursor = event.sequence;
      }
      state.cursor = batch.next_cursor;
      if (batch.closed) return;
    }
  }

  async close() {
    this.closed = true;
    for (const state of this.jobs.values()) state.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(state => state.promise));
    this.jobs.clear();
  }
}
