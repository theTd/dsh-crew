# Isolated Claude ↔ DSH worker messaging

Status: validated on dsh `0.2.2-alpha.2` for milestones M1–M2. Unit suite: 99 tests, 94 pass, 5 skipped, 0 fail
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
  `4` hub unreachable or unknown job, `64` bad arguments. Exit `4` reports the
  last observed status (or `unknown`), never an invented `failed`.
- **`src/job-log.mjs`** writes one JSONL file per job under `<config>/logs/`;
  `dsh_worker_log` reads the last events. The hub and the MCP process share the
  file, so a finished job leaves evidence after its process is gone.
- **Timeouts are per dispatch** (`timeout_seconds`), hub jobs included; the record
  settles as `timeout` with `timed out after Ns` and the session is disposed.
- **Messages have a ledger.** `pending` on accept, `delivered` when the next step
  starts, `refused` if the job settles first. A reply to a waiting tool counts as
  delivered immediately. The footer appends `(n undelivered)` when any were lost.
- **`dsh_worker_continue`** continues a settled job in the same session: a new job,
  the same session id, `continued_from` pointing back. A live handle is reused;
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

1. Claude dispatches with `dsh_spawn_worker`. The MCP process generates a private
   per-job token and passes it to the hub; tokens are not returned in job views.
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

## Dispatch behavior and limits

The development `ds-flash` and `ds-pro` roles now return an asynchronous dispatch
acknowledgement instead of blocking until the worker finishes. A foreground
blocking dispatch would prevent the main Claude agent from answering the worker.
The native Haiku wrapper can therefore finish before its DSH worker does; DSH
job status and the final result determine whether the underlying task completed.

Messaging currently supports running, hub-owned jobs; CLI/standalone workers cannot
be messaged. Completing a worker and continuing it in the same session is supported
(`dsh_worker_continue`, including the cold path after a hub restart); an MCP process
can only message jobs for which it holds the private token, so a new Claude/MCP
process cannot adopt an old process's mailbox. The existing general loopback
job/result endpoints retain their prior behavior; the token scopes message
delivery, not all access by other processes on the PC.

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
node --test tests/worker-mailbox.test.mjs tests/channel-relay.test.mjs tests/worker-messaging-registry.test.mjs tests/messaging-isolation.test.mjs tests/messaging-mcp.test.mjs
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
| `src/hub/index.mjs` | Hub messaging routes, worker setup, terminal events, isolated endpoint guards |
| `src/hub-client.mjs` | Per-MCP owner tokens and message HTTP calls |
| `src/server.mjs` | MCP message tools and optional channel capability |
| `src/install/install.mjs` | Config override, migration suppression, message tool names |
| `src/jobs.mjs`, `src/status-shard.mjs` | Redirect runtime sessions and status state |
| `src/multimodal.mjs`, `src/vision-route.mjs` | Redirect cache and attachment state |
| `agents/ds-flash.md`, `agents/ds-pro.md` | Asynchronous dispatch and reply guidance |
| `scripts/messaging-dev.ps1` | Isolated preparation/dependency/launch actions; pins the dsh generation and refuses a mismatched CLI |
| `scripts/smoke-hub.mjs` | Live M1 probe: hub reachability, spawn, result, cancel; exit codes 0/1/2/3 |
| `src/hub/model-selection.mjs` | dsh 0.2.2 `agent.model.select()` route application |
| `tests/worker-mailbox.test.mjs` | Ownership, replay, requests, abort, timeout |
| `tests/channel-relay.test.mjs` | Channel metadata and disconnect cleanup |
| `tests/worker-messaging-registry.test.mjs` | Steering, reply routing and cancellation lifecycle |
| `tests/messaging-isolation.test.mjs` | Configuration/state-root isolation |
| `tests/messaging-mcp.test.mjs` | Offline MCP/HTTP message round trip, including on-wire token refusal |
| `tests/hub-model-selection.test.mjs` | Route reaches `model.select()`; no `agent/request` rewrite |
| `tests/smoke-hub.test.mjs` | Probe arguments and the documented exit codes |
| `tests/hub-spawn-failure.test.mjs` | A failed spawn leaves no zombie job |
| `qa/` | Per-task cases, the shared `run-all.mjs`, and the standing gap list |
| `.gitignore` | Keep development runtime state out of Git |
| `docs/worker-messaging.md` | Design, limitations, pending verification and handoff |

Suggested commit title, following this repository's history:
`feat(workers): add isolated bidirectional messaging`.
Do not stage or commit without the user's separate explicit confirmation.
