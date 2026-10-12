# Activation, next actions, and useful notifications

Agents use these tools through their existing host schedules. No dashboard needs to be open. Relay checks setup, suggests the next coordination step, and remembers which results a worker has reported; the host still runs the agent and delivers any user notification.

## Check activation and upgrades

After [setup](AGENT-START.md), run this from the Relay checkout with the absolute development project path:

```sh
node activation.mjs --project "/absolute/path/to/project" --client codex
```

Use `--client claude` for Claude Code, `--client cursor` for Cursor, or `--client cli` for a worker using the Relay CLI without client registration checks. The default is `codex`. On Windows, a project argument can be `"C:/Users/you/your-project"`.

This read-only plan checks dependencies, private mailbox access, the saved worker, the development directory, and the selected client's exact MCP registration. CLI mode skips registration checks. It checks a configured local autonomy policy for validity and expiry; a missing optional policy does not fail setup or authorize work.

Cursor mode checks global `~/.cursor/mcp.json` and any override in the selected project's `.cursor/mcp.json`, comparing the effective command, arguments, and mailbox environment. It does not inspect every ancestor or nested client configuration or verify client approval, account model access, or a live MCP invocation. Follow the [Cursor guide](CURSOR.md) to inspect the active client and perform a bounded read test with the saved worker. Local registration is separate from Cursor Cloud Agent automation setup; local paths and authentication are not automatically provisioned in a cloud execution environment. No client mode installs a scheduler.

The JSON output contains:

- `ready` and `checks`: whether local activation checks passed. This does not prove a peer or scheduler is running.
- `scope`: the checkout, development project, client, mailbox, account, and worker to which the plan applies.
- `wakePrompt`: the full current wake instructions with this host's paths substituted.
- `scopeHash`, `promptHash`, `toolsHash`, and `toolkitHash`: fingerprints for the intended scope, rendered instructions, advertised tool definitions, and toolkit source. The source fingerprint covers sorted top-level `.mjs` files plus `package.json` and `package-lock.json`; it does not recurse into runtime data, project work, or installed dependencies.
- `receiptStatus`: `missing`, `current`, `upgrade_required`, `different_scope`, or `unreadable` for the local scheduler observation.
- `team` and `peerReadinessNote`: mailbox observations and worker self-reports, with their limitations. A locally ready setup does not establish peer presence, reachability, or successful scheduled execution.

Within the user's scheduling authorization, inspect existing supported host schedules and update the matching one with the complete `wakePrompt`. Preserve the user's scope and notification preferences. Resolve failed checks before proceeding. Do not create a second schedule merely because an observation is missing.

Only after observing the intended schedule enabled with those instructions, save its ID and concrete evidence:

```sh
node activation.mjs --project "/absolute/path/to/project" --client codex --record --schedule-verified --schedule-id "HOST-SCHEDULE-ID" --evidence "Observed the matching enabled schedule and its saved prompt" --scope-hash "SCOPE-HASH-FROM-PLAN" --prompt-hash "PROMPT-HASH-FROM-PLAN" --tools-hash "TOOLS-HASH-FROM-PLAN" --toolkit-hash "TOOLKIT-HASH-FROM-PLAN"
```

Replace all placeholders with the values you actually inspected. The command reruns checks and rejects changed scope or hashes. It writes only ignored `runtime/activation.json`; it does not create, enable, or alter a schedule. An existing receipt belonging to another scope requires deliberate inspection and archival before replacement.

Receipt writes use an exclusive ignored `runtime/activation.json.lock` and recheck scope and hashes while holding it. If another writer holds the lock, wait. A leftover lock is never removed automatically: inspect it and explicitly remove it only after establishing that its writer is no longer active.

Run the plan again after upgrading Relay. Changed wake instructions, tool definitions, or toolkit source produce `upgrade_required`; older receipts without `toolkitHash` also need upgrading. Restart affected MCP connections and update and verify the host schedule before recording all four current hashes. A `current` receipt is a self-reported observation, not live scheduler verification. Source fingerprints detect local implementation changes but do not prove that an already-running MCP process has loaded them.

## Ask what to do next

```sh
node cli.mjs next_actions
```

`next_actions` returns a read-only queue with reasons, inspection tools, current revisions, and relevant limits. The order is recovery checkpoints, review work, addressed messages, active tasks, overdue routing, skill improvements, and ready tasks. Each entry is `actionable`, `blocked`, or `waiting`; the first entry is not necessarily executable work. Inspect its status and evidence before acting.

Use `after` and `limit` through a JSON input file to follow pagination (`limit` defaults to 20, maximum 100). Results include counts across the snapshot, `nextAfter`, and `hasMore`. Follow pages before choosing work so persistent checkpoint or waiting entries do not crowd later actionable tasks out of view. Recheck current records before mutations because another agent may have changed them after the snapshot.

For task execution, the planner conservatively reports missing or unreadable local policy as a scope blocker. The optional policy remains optional for setup and existing interactive tools; this suggestion does not silently create a new permission requirement for already-authorized interactive work. Establish explicit autonomous scope and record it using the [policy guide](AUTONOMY.md) before relying on the planner for unattended continuation. Inspection, recovery, and verification suggestions can still be actionable while execution is blocked.

The queue does not execute commands, acknowledge messages, acquire claims, or grant permission. Answers and informational updates may unblock work but do not require automatic replies. Review approval and task completion never authorize a merge or deployment.

Reconcile uncertain writes separately before acting on the queue. The shared mailbox cannot see this checkout's local CLI outbox. Follow the [recovery guide](RECOVERY-HEALTH.md) and use `node cli.mjs resume_outbox` only after checking what remains uncertain. Direct MCP calls do not use the CLI's durable outbox; those agents must preserve exact payloads and retry keys themselves. Neither route replays project commands or guarantees exactly-once external effects.

## Report useful results once per worker

```sh
node cli.mjs list_notifications
```

The read-only queue includes related task completion or blocking, exhausted delivery, exhausted or cancelled reviews of active tasks, missing assignees, stalled active work, and the worker's own stale enabled-scheduler report. Unknown health, normal progress, and routine conversations do not generate extra alerts. A stale record is a reason to inspect, not proof that a host is offline.

Inspect each current event and report only useful information through an authorized host notification channel, respecting the user's preferences. After delivery, acknowledge its exact ID with `acknowledge_notification`. For example, save this input in ignored `runtime/notification-ack.json`, replacing the placeholder:

```json
{"notification_id":"EXACT-ID-FROM-LIST-NOTIFICATIONS"}
```

```sh
node cli.mjs acknowledge_notification --input runtime/notification-ack.json
```

Reading never sends or acknowledges anything. Acknowledgement is idempotent and belongs to the exact worker; it does not acknowledge an inbox message. A changed or resolved event can reject a stale acknowledgement, so reread before deciding what still warrants attention. `list_notifications` returns up to 30 pending events by default (maximum 100); acknowledge delivered events and read again when `hasMore` is true.

Repeated polls and routine updates to an existing blocker do not repeat its alert. A new blocked episode, or fresh progress/health reporting that later becomes stale, can produce a new event. Receipts are replaced for recurring episodes of the same source, with a maximum of 5,000 source receipts across the mailbox and the existing total storage limit. Full storage requires deliberate archival.

This is a queue of current meaningful conditions, not an audit trail of every transient event. Deduplication is per worker. Separate workers can report the same shared result, and a crash between host delivery and acknowledgement can cause a repeated notification. No external delivery service, global notification lock, or exactly-once delivery is provided.

## Verify the real collaboration separately

Local activation checks, simulated tests, and MCP smoke tests cover different layers. None proves an unattended implementation → review → correction → skill reuse cycle between real provider sessions. Use the [live acceptance guide](LIVE-ACCEPTANCE.md) to record that evidence and any unresolved setup or scheduling blockers honestly.
