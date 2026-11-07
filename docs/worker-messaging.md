# Isolated Claude ↔ DSH worker messaging

Status: validated on dsh `0.2.2-alpha.2` for milestones M1–M2. Unit suite: 117 tests, 112 pass, 5 skipped, 0 fail
(the TOML installer cases skip because `python3`/`tomllib` is not on this
machine's `PATH`; the `pattern-audit-regressions` agy case skips on Windows
because its fixture is a POSIX shell shim — both reasons are in `qa/gaps.md`).
QA cases: `node qa/run-all.mjs`, 16/16. Live hub checks passed: spawn →
`SMOKE-OK`, cancel → `cancelled`, a 2 s bound → `timeout`, and `continue` → the
resumed worker answered `PERSIMMON` from its first turn.

Development checkout: `C:/Users/cui/standalone/dsh-crew-messaging`.
Starting revision: `b0ddd92` (`0.1.0-rc.14`). Work branch: `crew/port-hub-dsh-0.2.2`.

The `dsh-agent-spine-demo`, `dsh-sdk-client` and `dsh-sdk-jsonrpc-demo` packages
this checkout was written against no longer exist in dsh 0.2.2, and the 0.1.x
model-selection hook was replaced with `agent.model.select()`
(`src/hub/model-selection.mjs`). Hub mode is the only dispatch path; standalone
dispatch was removed with one fixed error (ADR 0002).

**Minimum dsh: `0.2.2-alpha.2`.** Every worker dispatch now calls
`agent.model.select()`; a host without it refuses with a fixed sentence instead
of silently dispatching on the wrong route, and `package.json` declares no lower
bound yet — this line is that bound until the reader-facing version matrix lands.

## Dispatch contract (M2)

- **Every job tool ends with** a footer and `crew_job: {...}` — job id, status,
  model, step, tool calls, tokens, elapsed, message ledger, lease deadline, log
  path, and a `wait_command`.
- **`src/wait-job.mjs`** waits without polling. Exit codes: `0` done, `1`
  failed/cancelled/timeout, `2` needs input, `3` still running at the deadline,
  `4` hub unreachable or unknown job, `5` a worker message is waiting (relay it,
  then run the printed wait command again), `64` bad arguments. Exit `4` reports
  the last observed status (or `unknown`), never an invented `failed`.
- **`src/job-log.mjs`** writes one JSONL file per job under `<config>/logs/`;
  `dsh_worker_log` reads the last events. The hub and the MCP process share the
  file, so a finished job leaves evidence after its process is gone.
- **Timeouts are per dispatch** (`timeout_seconds`), hub jobs included; the record
  settles as `timeout` with `timed out after Ns` and the session is disposed.
- **Messages have a ledger.** `pending` on accept, `delivered` when the next step
  starts, `refused` if the job settles first. A reply to a waiting tool counts as
  delivered immediately. The footer appends `(n undelivered)` when any were lost.
- **`dsh_worker_continue`** continues a settled job in the same session: a new job,
  the same session id, `continued_from` pointing back, and — like a spawn — its own
  mailbox when the dispatcher supplies a messaging token. A live handle is reused;
  after a hub restart the persisted session is resumed.
- **`status` is session-scoped** by default (`all: true` for the machine view) and
  capped near 8 KB.
- **Leases are opt-in** (`lease_seconds`, 60–3600): a 15 s watchdog cancels a
  running job whose dispatcher stopped polling, with the fixed error
  `cancelled: dispatcher stopped polling (lease expired)`. Jobs without a lease
  are never swept.
- **Standalone dispatch is removed** on 0.2.2 (ADR 0002): one fixed error, no
  lock and no registry entry.

Independent read-only audit: the malformed worker-tool parameter schema and the
PowerShell empty-argument concern have been addressed in source. The worker tool
now supplies full JSON Schema to raw registration and checks arguments before
touching its mailbox. The launcher requires PowerShell 7.3 or newer and scopes
native argument passing to `Standard` during the Claude launch, restoring the
previous mode afterwards. The worker-tool schema case runs in the unit suite; the
PowerShell argument-passing fix has no automated case.

## Message flow

1. Claude dispatches with `dsh_spawn_worker` (or continues one with
   `dsh_worker_continue`). The MCP process generates a private per-job token and
   passes it to the hub; tokens are not returned in job views.
2. The hub mounts `message_parent` in that worker's scoped tool registry. The
   tool can only write to its own mailbox; it accepts no caller-supplied job id.
3. Claude sends `dsh_worker_message(job_id, message)`; the hub uses the public
   DSH `Agent.steer()` API to admit it at the next step boundary.
4. The worker calls `message_parent(message)`. Its event is appended to a bounded,
   replayable mailbox, which the MCP relay long-polls.
5. With `DSHPLUGIN_CREW_CHANNELS=1`, the MCP server declares `claude/channel` and
   sends `notifications/claude/channel` with `job_id`, `message_id`, and `kind`.
   Claude's session must explicitly enable this local development channel.
6. For dialogue, the worker calls
   `message_parent(message, wait_for_reply=true, timeout_seconds=60)`.
   Claude answers with `dsh_worker_message(job_id, message, reply_to=message_id)`.
   This resolves the waiting worker tool directly; it does not require another
   model step to interrupt a tool that is already waiting. The maximum wait is
   180 seconds. Timeout returns `timed_out: true`, never an invented answer.
7. Completion is another mailbox event. Claude must still collect the full final
   result with `dsh_worker_result`; the push preview is limited to 16,000 characters.

Without channels, use `dsh_worker_messages(job_id, after, wait_seconds)` and carry
`next_cursor` into the next request. Reads do not consume messages for other
readers. At most 256 events are retained per job; `has_gap` explicitly reports
expired events. A disconnected HTTP reader aborts its long-poll. MCP disconnect
aborts the relay's pending HTTP reads.

Agent messages are explicitly marked as agent-generated context and cannot grant
human permission. Existing `ask_user_question` handling is preserved: it stops
the worker with `needs_input` and returns the question. No automatic approvals
are added.

## Wake path: a worker message wakes the dispatcher

A worker's `message_parent` call no longer has to wait for an explicit poll. The
background `wait_command` now treats a worker message as a wake-up event:

1. **Token handoff.** When this MCP session creates a messaging-enabled hub job —
   spawned or continued — `src/hub-client.mjs` writes the job's private token to
   `<config>/tokens/<job-id>` (mode 0600, best effort on Windows) through
   `src/job-token-store.mjs`. The server deletes the file once it observes the
   job settled and deletes the files it wrote when the MCP process exits
   normally. Files older than 24 h are pruned at startup, so a crashed session
   cannot leave a usable token behind forever.
2. **Mailbox long-poll.** While the token file exists, `src/wait-job.mjs` first
   long-polls `GET /_dsh/dsh-crew/jobs/<id>/messages?after=<n>&wait=<0..30>`
   with the `x-dsh-crew-job-token` header, then checks the job status with
   `wait=0`. The two waits are sequential, so the status/settled/deadline logic
   and its exit codes are unchanged.
3. **Exit 5.** If the poll returns at least one event with `kind: "message"` and
   `sequence > --after`, the command prints one line per message:

   ```text
   worker_message: {"message_id":"...","text":"...","expects_reply":true,"created_at":"..."}
   ```

   then the usual footer and `crew_job:` block, whose `wait_command` carries
   `--after <next_cursor>`, and exits `5`. A `completion` event never exits 5;
   it falls through to the status check, which reports the settled job with its
   usual exit code. `--after` defaults to 0 and is non-negative.
4. **Fallback.** No token file, a denied or malformed mailbox answer, or a hub
   without the messaging route: the wait behaves exactly as before (status-only
   waiting, no new exit code). A mailbox *network* error counts like any other
   unreachable-hub error: retry, then exit 4.
5. **Dispatcher relay.** `agents/ds-flash.md` and `agents/ds-pro.md` restart the
   printed wait command first, then end their turn with one line per worker
   message for the coordinator:

   ```text
   WORKER MESSAGE job <job_id> message_id=<id> reply_requested=<true|false>: <text verbatim>
   ```

   The coordinator replies through SendMessage to that agent; the agent forwards
   it with `dsh_worker_message`, using `reply_to` = the most recent unanswered
   `expects_reply` message id. A stop/cancel request is not forwarded — the agent
   cancels the job instead. If the spawn response carries no `wait_command`
   (an older server), the dispatcher returns the job id and status immediately
   and the caller fetches it with `dsh_worker_result`.

A job created by `dsh_worker_continue` is messaging-enabled exactly like a
spawned one: the MCP server mints a token for the new job, the hub creates that
job's own fresh mailbox, and the continued turn can be steered, read, answered
with `reply_to`, and ends with a `completion` event and a closed mailbox when it
settles. The token file follows the new job, so the background waiter wakes on its
messages too.

The worker's `message_parent` tool resolves its mailbox when it runs, not when it
was registered. A continuation on the live agent therefore writes into the new
job's mailbox instead of the previous job's closed one, and the cold resume path
(after a hub restart) registers the same tool once on the resumed agent. A
continuation created WITHOUT a token keeps the old behavior — no mailbox, no
waiter wake — and a `message_parent` call there fails with a clear "no open
mailbox" error instead of writing into a stale mailbox.

Compatibility runs both ways. A new MCP server against an old hub still continues
the job (the old hub ignores `messaging_token`); that waiter then gets a refused
mailbox read and falls back to the status-only wait. An old MCP server against the
new hub sends no token, so the continued job has no mailbox, exactly as before.

**The hub runs in-process in the DSH web host.** This hub-side continue change
therefore takes effect only after that host is restarted; until then, a new MCP
session keeps the ignored-token behavior described above.

The token file is a capability, not a record: it is removed when the job settles
or the process exits, and never appears in a job view, a log line or a commit.

## Dispatch behavior and limits

The development `ds-flash` and `ds-pro` roles are full dispatchers: they spawn
once, keep a background `wait_command` running, relay worker messages and
coordinator replies, and report the final result. They never block in a
foreground wait, because that would hold back messages from the coordinator.
The native Haiku wrapper can therefore finish a turn before its DSH worker does;
DSH job status and the final result determine whether the underlying task
completed.

Messaging supports running, hub-owned jobs — including a job created by
`dsh_worker_continue` when its dispatcher supplied a token; CLI/standalone workers
cannot be messaged. Completing a worker and continuing it in the same session is
supported (`dsh_worker_continue`, including the cold path after a hub restart),
and the continued turn is messaged through its own mailbox. An MCP process can
only message jobs for which it holds the private token (spawn and continue both
mint one), so a new Claude/MCP process cannot adopt an old process's mailbox. The
existing general loopback job/result endpoints retain their prior behavior; the
token scopes message delivery, not all access by other processes on the PC.

The channel relay stops and logs an error if its HTTP read or notification fails;
the explicit mailbox polling tool remains available. Automatic reconnect/replay
across process restarts is not provided in this initial implementation.

## Isolation

`DSHPLUGIN_CREW_CONFIG_DIR` redirects config, status shards, standalone session
files, vision cache and attachments together. It must be an absolute path.
Legacy configuration migration is suppressed when this override is set.

`scripts/messaging-dev.ps1` prepares everything under the ignored
`.messaging-dev/` directory:

| Component | Location or setting |
| --- | --- |
| DSH home | `.messaging-dev/dsh-home` via `DSH_HOME` |
| Shared agent configuration | `.messaging-dev/agents-home` via `DSH_AGENTS_HOME` |
| Plugin state | `.messaging-dev/crew-state` |
| Scratch workspace | `.messaging-dev/workspace` |
| Dependencies | `.messaging-dev/dependencies`, linked only into this checkout |
| Claude test roles | `.messaging-dev/claude-plugin` |
| MCP configuration | `.messaging-dev/mcp.json` |
| Hub port | `3081` by default; `3080` is explicitly refused |

The launcher uses process-scoped environment variables and restores them on exit.
It does not change the system environment, scheduled tasks, existing profile,
installed Claude plugin, or global plugin settings. Existing processes are never
stopped. An occupied development port causes launch to fail.

`DSHPLUGIN_CREW_ISOLATED=1` disables the development hub's global installer and
process-kill endpoints. The profile has only the base, web, and development crew
bundles. Production provider configuration and credentials are not copied;
configure a provider in the separate development host before a live model trial.
The sandboxed profile references the installed DSH runtime but has its own data.

Claude starts as a new session using explicit MCP configuration, the development
roles, and no user/project/local settings sources. Its normal authentication is
reused; it may create a new conversation record under Claude's normal session
storage. This does not attach to or resume a running conversation. CPU, network,
and subscription/API quota remain shared resources.

The development MCP launches `src/server.mjs` directly. The tracked distribution
bundle `lib/server.mjs` has deliberately not been rebuilt. Do not install this
checkout globally or overwrite either running installation.

## Development commands

Run commands from this checkout in PowerShell 7.3 or newer (`pwsh`), not Windows
PowerShell 5.1.

Prepare local files, without starting services:

```powershell
./scripts/messaging-dev.ps1 -Action Prepare
```

Install the development dependency set with lifecycle scripts disabled. The
isolated profile generated here pins `@deepseek-ai/dsh-base` and
`@deepseek-ai/dsh-web-app` to `-DshVersion` (default `0.2.2-alpha.2`); pnpm's
`latest` tag for those packages is still `0.0.1-rc.1`, so the pin is load-bearing:

```powershell
./scripts/messaging-dev.ps1 -Action InstallDependencies
```

Start the isolated host. The isolated `DSH_HOME` has no provider credentials, so
a live model trial needs a provider configured there first; the profile itself
loads without credentials. `-DshEntry` must point at the same dsh generation the
profile pins: omitting it uses the default path, and this machine's `dsh` there is
`0.2.1-alpha.5`, which is the wrong CLI for a `0.2.2-alpha.2` profile.

```powershell
./scripts/messaging-dev.ps1 -Action StartDsh -DshEntry <path to dsh 0.2.2 lib/bin.js>
```

For a live trial that reuses this machine's working model route, boot a temporary
profile in the real `DSH_HOME` instead (no credentials are copied, and the `web`
profile is untouched). A profile created by `dsh plugin ... add` starts as a
base-only profile, so create it from the web template first; the API key itself
comes from that home's `~/.dsh/.credentials.yaml`, never from the patch file:

```powershell
dsh crew-m1 --from-default-profile web --port 3082          # creates it from the web template; stop it
dsh plugin --profile crew-m1 add link:<this repo>
# then set the `llm-deepseek` and `agent-default-model` rows in
# ~/.dsh/profiles/crew-m1/cordis.patch.yml to a route that host already has
node <dsh 0.2.2>/lib/bin.js --profile crew-m1 --host 127.0.0.1 --port 3082 --no-open
```

Dispatch one worker through the MCP shim (pass, prints `job_id`, `status: done`):

```powershell
node scripts/smoke-hub.mjs --hub http://127.0.0.1:3082 --timeout 180
```

Cancel one long worker (prints `status: cancelled`):

```powershell
node scripts/smoke-hub.mjs --hub http://127.0.0.1:3082 --cancel
```

The offline integration test uses the actual MCP process and hub HTTP routes with
a fixture replacing only the DSH model/driver. It does not launch Claude, contact
a model provider, or use credentials:

```powershell
$env:DSHPLUGIN_CREW_CONFIG_DIR = Join-Path $PWD '.messaging-dev/test-state'
node --test tests/worker-mailbox.test.mjs tests/channel-relay.test.mjs tests/worker-messaging-registry.test.mjs tests/messaging-isolation.test.mjs tests/messaging-mcp.test.mjs tests/hub-continue-messaging.test.mjs tests/continue-old-hub.test.mjs
Remove-Item Env:DSHPLUGIN_CREW_CONFIG_DIR
```

After separate permission for live trials, start the isolated host and a new
Claude session in two terminals:

```powershell
./scripts/messaging-dev.ps1 -Action StartDsh
# In a second terminal:
./scripts/messaging-dev.ps1 -Action StartClaude
```

The Claude launch uses `--dangerously-load-development-channels
server:dsh-messaging`. The current Claude build's development-channel path has an
interactive confirmation. This is required because the local channel is not on
the approved plugin list. It does not enable the separate channel permission
approval capability.

Live acceptance trial: ask Claude to spawn a worker which asks for a random
label with `wait_for_reply=true`; have Claude reply with that label; verify that
the same worker reports receiving it and completes. Also try ordinary steering,
an incorrect owner, cancellation, and a real human approval question. Keep all
file work inside the scratch workspace. These trials are pending approval.

## Changed files

| Files | Responsibility |
| --- | --- |
| `src/config-paths.mjs` | Shared isolated state-root resolution |
| `src/worker-mailbox.mjs` | Owner checks, bounded replay, waiting replies, scoped worker tool |
| `src/channel-relay.mjs` | Hub mailbox to Claude channel adapter |
| `src/hub/index.mjs` | Hub messaging routes, worker setup, continued-job mailboxes and worker-tool re-targeting, terminal events, isolated endpoint guards |
| `src/hub-client.mjs` | Per-MCP owner tokens and message HTTP calls; token minting and token-file handoff at spawn and continue |
| `src/job-token-store.mjs` | Per-job token handoff files: write / read / delete / 24 h prune (0600) |
| `src/wait-job.mjs` | Wake path: mailbox long-poll, exit 5, `--after` cursor |
| `src/server.mjs` | MCP message tools, optional channel capability, token cleanup on settle/startup, post-continue wiring |
| `src/install/install.mjs` | Config override, migration suppression, message tool names |
| `src/jobs.mjs`, `src/status-shard.mjs` | Redirect runtime sessions and status state |
| `src/multimodal.mjs`, `src/vision-route.mjs` | Redirect cache and attachment state |
| `agents/ds-flash.md`, `agents/ds-pro.md` | Full dispatcher: dispatch, background wait, wake relay, report, continue |
| `scripts/messaging-dev.ps1` | Isolated preparation/dependency/launch actions; pins the dsh generation and refuses a mismatched CLI |
| `scripts/smoke-hub.mjs` | Live M1 probe: hub reachability, spawn, result, cancel; exit codes 0/1/2/3 |
| `src/hub/model-selection.mjs` | dsh 0.2.2 `agent.model.select()` route application |
| `tests/worker-mailbox.test.mjs` | Ownership, replay, requests, abort, timeout |
| `tests/channel-relay.test.mjs` | Channel metadata and disconnect cleanup |
| `tests/worker-messaging-registry.test.mjs` | Steering, reply routing and cancellation lifecycle |
| `tests/messaging-isolation.test.mjs` | Configuration/state-root isolation |
| `tests/messaging-mcp.test.mjs` | Offline MCP/HTTP message round trip, on-wire token refusal, token-file handoff/cleanup, continued-job round trip |
| `tests/hub-continue-messaging.test.mjs` | Continued-job mailbox, `message_parent` re-targeting (live and resumed), no-token refusal, one tool per agent |
| `tests/continue-old-hub.test.mjs` | New MCP continue against an old hub: token file written, waiter falls back to status-only |
| `tests/job-token-store.test.mjs` | Token file round-trip, safe file names, malformed files, 24 h prune |
| `tests/wait-job.test.mjs` | Exit codes 0/1/2/3/4/5, worker_message lines, `--after`, fallbacks |
| `tests/hub-model-selection.test.mjs` | Route reaches `model.select()`; no `agent/request` rewrite |
| `tests/smoke-hub.test.mjs` | Probe arguments and the documented exit codes |
| `tests/hub-spawn-failure.test.mjs` | A failed spawn leaves no zombie job |
| `qa/` | Per-task cases, the shared `run-all.mjs`, and the standing gap list |
| `.gitignore` | Keep development runtime state out of Git |
| `docs/worker-messaging.md` | Design, limitations, pending verification and handoff |

Suggested commit title, following this repository's history:
`feat(workers): add isolated bidirectional messaging`.
Do not stage or commit without the user's separate explicit confirmation.
