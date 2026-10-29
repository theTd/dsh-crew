# Changelog

What changed in each released version of `@zseven-w/dsh-crew`, newest first.

## Unreleased

### Breaking

- **Requires dsh `0.2.2-alpha.2`.** The 0.1.x model-selection hook is gone; the
  worker's route is applied with `agent.model.select()` before its first step.
- **Hub mode only.** Dispatch without a running DSH instance is refused with one
  fixed sentence instead of launching the old SDK runtime, which no longer exists
  in dsh 0.2.2. A CLI backend (`worker="agy"` / `"grok"`) is unaffected.
- **`dsh_worker_status` defaults to this session's jobs.** Pass `all: true` for
  every job the hub knows, as before.

### Added

- **Every job tool ends with `crew_job: {...}` and a footer**, including a
  `wait_command` and the message ledger (`delivered` / `pending` / `refused`).
- **`node src/wait-job.mjs <job-id>`** waits for a settlement without polling:
  exit `0` done, `1` failed/cancelled/timeout, `2` needs input, `3` still
  running at the deadline, `4` hub unreachable or job unknown, `64` bad
  arguments.
- **`dsh_worker_log`** reads a job's last events from `<config>/logs/<id>.log`
  (200-event ring, clipped summaries).
- **`dsh_worker_continue`** asks a settled worker a follow-up in the same
  session; the new job carries `continued_from`.
- **Per-dispatch timeouts, hub jobs included.** At the bound the job settles as
  `timeout` with `timed out after Ns`.
- **Opt-in lease** (`lease_seconds`, 60–3600) on `dsh_spawn_worker`: a job is
  cancelled with `cancelled: dispatcher stopped polling (lease expired)` when
  the dispatcher stops polling. Jobs without a lease are never auto-cancelled.

### Fixed

- A worker no longer dies on its first request under dsh 0.2.2 (the old hook
  rewrote `agent/request`, which 0.2.2 rejects).
- A spawn that fails after creating its record no longer leaves a zombie job
  whose status says `running` forever.
- The per-job message token is enforced on the wire, not only in-process; a
  missing or foreign token is refused by the hub route.
