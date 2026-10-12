# Recovery and team health

These tools run through MCP or CLI during an agent's existing wake schedule. The dashboard is optional. They store and inspect coordination records; they do not run commands, start models, create schedules, or repair machines.

## Save progress before an interruption

Call `save_checkpoint` after accepting a task and after meaningful work segments. Supply `agent_id`, `task_id`, the current task revision as `expected_task_revision`, and the checkpoint's `expected_revision` (`0` for the first checkpoint). Include a stable `request_id`, `summary`, nonempty `next_steps`, and optional `artifacts` references.

```json
{
  "task_id": "TASK-ID",
  "expected_task_revision": 2,
  "expected_revision": 0,
  "request_id": "parser-checkpoint-001",
  "summary": "Parser updated; focused tests remain to run.",
  "next_steps": ["Inspect the working diff", "Run the parser tests"],
  "artifacts": ["branch: feature/parser"]
}
```

Save this payload in ignored runtime storage and use `node cli.mjs save_checkpoint --input runtime/checkpoint.json`; the CLI supplies your saved worker identity. MCP calls require `agent_id` explicitly. Preserve the exact payload and retry key after uncertain delivery. Reusing a key with different content fails. Checkpoint revision checks prevent conflicting writers, and the task revision check rejects recording stale task context as current.

Only the assigned worker can save a checkpoint for an `in_progress` or `blocked` task. Each worker has a separate checkpoint per task. Up to 500 checkpoint records and 30 entries per checkpoint are retained; capacity fails explicitly instead of silently deleting retry history.

## Resume on the next wake

`get_recovery` returns your assigned active tasks, your checkpoints, actionable unread addressed messages, and ready tasks you created or initiated routing for. It also retains old checkpoints whose tasks finished or moved to another worker. Check `needsRevalidation`, `currentTaskRevision`, and `currentTaskStatus`; a historical checkpoint never grants ownership.

Recovery also includes review cycles where you are the builder or designated reviewer, and pending skill improvement proposals you created or that concern your skills. A reviewer can discover an awaiting review on a wake even when no separate message was sent.

Before continuing, inspect the current task, use `check_task`, check claims, and verify real artifacts against the latest user scope. `needsRevalidation: false` only means the recorded task context matches; it is not approval to execute. Reading recovery does not acknowledge messages. Handle or durably record messages before acknowledging them, and do not automatically reply to answers or updates.

Checkpoints cannot provide exactly-once external execution. A crash after a command or push but before its checkpoint can leave an uncertain result. Inspect the filesystem, branch, PR, or other actual outcome before repeating an action. Checkpoints and artifact references are shared in private mailbox Git history: exclude credentials and personal transcripts.

The local outbox preserves exact retry-safe coordination payloads before delivery. Its allowlist excludes worker registration, profile updates and health reports because they lack stable request keys. Replays invoke only Relay coordination operations for the saved worker; they never run shell commands or repeat external project actions. Each replay attempts at most 20 pending entries. Delivered entries remain as retry-key records, with a 500-record capacity and 100 KB per-record limit; archive deliberately when full. Corrupt records fail closed. Failed delivery remains pending and still requires current ownership, revisions and policy checks when retried.

## Retry queued CLI operations

The CLI automatically journals supported writes under ignored `runtime/outbox/`,
scoped to the mailbox repository. On restart, run:

```sh
node cli.mjs resume_outbox
```

Inspect the returned statuses; pending operations may need a fresh task revision
or a user decision. Never change the payload of an uncertain retry key. An
obsolete request must be reconciled with shared state and archived deliberately,
not silently replaced. The outbox preserves delivered records as deduplication
history. Direct MCP clients must preserve their own exact uncertain call payloads;
the local CLI journal is not an MCP transport queue. Both transports use the
same server-side retry keys and revision checks.

Replay visits at most 20 pending records per call in filename order. Persistent
conflicts among those records can hold up later work: inspect the corresponding
shared records, preserve evidence, and deliberately archive obsolete local
requests after reconciliation. Concurrent insertion at the 500-record boundary
may temporarily exceed capacity; payloads are retained, and replay stops until
the overflow is inspected and archived. Neither case silently drops work.

## Report and diagnose worker health

`report_worker_health` records `scheduler_status` (`enabled`, `disabled`, or `unknown`), `expected_interval_minutes` (1–1440, required when enabled), and `expected_revision` (0 initially). Only the worker's owning account can report its health. Read the current revision from `team_health`. A report is a self-report, not independent verification of the host or scheduler.

`team_health` is read-only. Its `stale_minutes` defaults to 30 (range 1–10080). Diagnostics identify expired availability, missing or stale health reports, disabled or unknown reported scheduling, assigned ready tasks awaiting acceptance, stale active or blocked tasks, unknown assignees, exhausted review cycles, and published skill versions with at least two reported failures. A worker report becomes stale after the larger of `stale_minutes` or twice its reported wake interval. Long-running tasks and deliberate blockers may legitimately appear stale.

These observations do not prove authentication failure, host reachability, actual schedule operation, or skill quality. Agents investigate within their authorized scope and ask humans only for decisions they cannot make. Relay does not silently repair authentication, create a replacement scheduler, or notify anyone from a health read.
