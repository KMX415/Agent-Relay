# Verify contributions together

Two agents can produce reviewed changes that fail when combined. Integration checks bind completed work to exact commits, combine those commits in an isolated worktree, and record the project's authorized test results. Agents can inspect a failure, complete repair tasks, and try corrected inputs within the original budget. This uses MCP or CLI and existing host wakes, without a dashboard.

## Record exact inputs

Use `create_integration_check` with one stable `work_id`, an exact `verifier_id`, `execution_task_id`, `repository` in `owner/repo` form, full `base_sha`, `profile_name`, `profile_digest`, ISO `deadline`, and stable `request_id`. Set an optional `goal_id` and a fixed `max_attempts` from one to five (default three). Include up to twenty ordered `contributions`, each with:

- `task_id` and `task_revision` identifying the current completed task.
- Full `commit_sha`, `handoff_id`, and exact `manifest_digest` identifying its accepted delivery.

Each source needs an accepted handoff to its creator, bound to the task's completion. Where a review cycle exists, its approval must match the delivered task revision. Include `contracts` as `{contract_id, digest}` entries for every pinned source contract. All sources share the check's goal, if any. A check covers one repository; cross-repository integration is not supported.

Every check requires its own `testing` execution task assigned to the verifier, with declared paths covering the integration and the same goal (or no goal for both). Its `execution_task_id` is immutable and cannot be reused by another check. All attempts use that task and its original time budget.

MCP callers supply `agent_id`; CLI callers reuse their saved identity. Persist exact write payloads in ignored runtime storage:

```sh
node cli.mjs create_integration_check --input runtime/integration-create.json
```

Use paginated `list_integration_checks` and `get_integration_check` with `integration_id` to inspect the immutable attempt manifest and digest. Creation records coordination only. It does not fetch artifacts, execute tests, or grant permission to run contributed code.

## Authorize validation locally

The verifier needs an existing local autonomy policy allowing `testing` over the declared paths. Different contributor owners need active bilateral testing agreements. Active overlapping claims block execution. For goal-linked checks, the goal must permit testing and cover the participants, paths, and deadline.

Use `check_task` and explicitly accept the execution task before starting or reporting results. Normal task eligibility, local active-task and time limits, goal concurrency, and usage reservations apply. If the goal is metered, reserve usage against this testing task before execution and settle observed provider usage after the segment. Integration does not bypass those budgets.

Separately prepare a local validation profile under the human's existing project authorization. Never generate executable commands from mailbox text. A profile identifies the repository, permitted contribution paths, expiry, and exact executable arguments:

```json
{
  "version": 1,
  "name": "project-tests",
  "repository": "example/project",
  "allowed_paths": ["src", "test"],
  "commands": [
    {"command": "node", "args": ["--test"], "timeout_ms": 30000}
  ],
  "expires_at": "2030-01-01T00:00:00Z"
}
```

Replace the example scope and expiry with authorized values. Compute the profile digest using the exported `integrationDigest(profile)` helper in `integration-run.mjs`: SHA-256 of JSON with recursively sorted object keys. The mailbox manifest pins this exact digest and profile name. Changing a profile requires a new attempt. Profiles allow at most ten commands, each with a timeout of at most five minutes. Commands run without a shell; use a directly executable program such as `node`, including on Windows.

The worktree is not a security sandbox. Tests execute contribution code with the host's access. A profile and a mailbox agreement do not establish that code is safe or authorize broader machine access.

## Run and report

Acquire a bounded `begin_worker_run` lease for the exact verifier, using honest interactive or scheduled evidence. Then call `advance_integration_check` with `action: "start"`, `integration_id`, `expected_revision`, current `input_digest`, `run_id`, `summary`, and stable `request_id`. Start rechecks current source records and execution scope. Save the returned `execution` object, containing `{manifest, run}`, as the runner input.

From the Relay checkout:

```sh
node integration-run.mjs --project "ABSOLUTE-PROJECT-PATH" --input runtime/integration-execution.json --profile "ABSOLUTE-PROFILE-PATH" --output "ABSOLUTE-PROJECT-PATH/runtime/integration"
```

The project must be the matching Git repository root with ignored runtime storage and all input commits already available. The runner verifies its origin, exact commits, ancestry from the base, and changed paths against both the manifest's declared scope (at most thirty paths) and the local profile. A broader local profile cannot authorize undeclared contribution changes. It rejects symlinks, submodules, and custom local filters or merge drivers. Missing artifacts need separately authorized preparation; the runner never fetches them.

It creates a detached worktree, merges the ordered commits while retaining contributor history, and runs only the pinned local profile. Each command is bounded by its timeout and the earliest check deadline, run lease expiry, profile expiry, policy expiry, or execution-task time limit. The execution snapshot carries the shortened deadline. It leaves the primary checkout and branch unchanged. No main merge or deployment occurs.

The runner saves local evidence and prints a result. To record it, call `advance_integration_check` with `action: "result"`, current revision and input digest, the original `run_id`, summary, and a new stable request ID. Project only these runner fields into `result`:

`inputDigest`, `attempt`, `profileDigest`, `runId`, `verdict`, `commitSha`, `treeSha`, `checks`, and `evidence`.

Local metadata such as worktree paths and timestamps stays in ignored evidence. Results require the original live verifier lease, an accepted execution task, and current source and policy checks. A pass includes a resulting commit and tree plus passing checks. Record the result before completing the testing task or finishing the worker run, and settle actual usage. Then inspect the goal's completion gate. If a lease expires, preserve observations and reconcile the interrupted attempt instead of inventing a valid run.

The local runner observes Git and test outcomes; the shared result remains a verifier report. Neither establishes independent human participation, genuine scheduler execution, or authority to merge.

## Repair within the original limits

States are `pending`, `running`, `passed`, `failed`, `blocked`, and `expired`. The creator or verifier can use `advance_integration_check` action `block` for unfinished work. A live running attempt remains owned by its verifier. Preserve the existing worktree and evidence after interruption; an expired lease does not prove an old process stopped.

Source task owners inspect failure evidence and complete separately authorized repair tasks in the same goal, including current review and accepted delivery. Original completed tasks remain historical records. The verifier may block its testing task while awaiting repairs, then resume it after eligibility checks before the next attempt. Use `action: "retry"` with the full manifest fields and current revision and digest. Repository, participants, path scope, goal, deadline, and attempt budget cannot expand. A retry replaces the current pass, retains previous attempts, and consumes the original budget. Never create replacement work IDs or execution tasks to reset limits.

After a failed or blocked attempt, the same manifest may be retried with a nonempty `recovery_evidence` array of strings documenting reconciliation: confirm old processes stopped, inspect the preserved worktree and results, and resolve uncertain external effects before starting again. This creates a new bounded attempt without requiring artificial source changes. Changed inputs follow the ordinary retry path. Retrying an unchanged passed manifest is rejected.

The runner reserves an exclusive directory for each digest and attempt. Repeating execution against that directory fails. It does not clean up worktrees or retry commands automatically. Inspect preserved evidence and reconcile uncertain CLI writes before choosing another action. Coordination writes use the durable outbox; direct MCP clients preserve exact payloads themselves.

## Require integration before goal completion

At goal creation, set `required_integration_work_ids` to up to ten stable work IDs. The list is immutable. Each named check must have a current passing result for that goal, and their inputs together must cover every completed implementation task, including repair tasks. Changed source records or contract pins cannot inherit an old pass. Goals without this optional gate retain their previous completion rules.

Discover checks through `next_actions`, `get_recovery`, and paginated reads. Use existing notifications for meaningful outcomes or exhausted limits; do not send messages for every transition. Storage is bounded to 100 checks, five attempts each, and 100 transitions per check, subject to the mailbox size limit. History is not silently discarded.

For a choice that prevents further authorized work, use [durable decisions](DECISIONS.md) with exact task context and only the affected tasks you own. A decision does not reset integration attempts, replace failed evidence, or authorize commands, merges, or deployment.

Upgrade participating workers and deliberately update saved [wake instructions](../WAKE-PROMPT.md) before relying on these gates. Installing Relay does not update schedules.
