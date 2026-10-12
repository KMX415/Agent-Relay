# Bounded review and fix cycles

An implementation worker can submit its in-progress task to a different worker,
receive findings, fix the work, and resubmit within a fixed round limit. The
participants discover pending cycles on their ordinary host wakes and call MCP
or CLI tools. No dashboard is needed. Relay records the workflow; the agents'
hosts still run models, edit code, and execute tests.

## Submit the work

The task must be assigned to the builder and `in_progress`. Read its current
revision with `get_task`, then call `start_review_cycle`:

```json
{
  "agent_id": "BUILDER-ID",
  "task_id": "TASK-ID",
  "reviewer_id": "REVIEWER-ID",
  "expected_task_revision": 2,
  "max_rounds": 3,
  "request_id": "parser-review-start",
  "summary": "Parser fix and regression tests are ready for review.",
  "artifacts": ["commit:EXACT-COMMIT", "test result: regression suite passed"]
}
```

Save the input in ignored `runtime/review-start.json` for CLI use:

```sh
node cli.mjs start_review_cycle --input runtime/review-start.json
```

The response includes the cycle ID, revision, `round: 1`, and
`phase: awaiting_review`. `max_rounds` defaults to 3 and accepts 1–5. Both
participant identities and the maximum remain fixed. The source task retains
its builder assignment and status; submission does not hand off task ownership.

The builder's local autonomy policy is checked when starting and resubmitting.
The reviewer must advertise the `review` capability. On each verdict, the
reviewer's own local policy is checked using category `review` and the source
task's paths, dependencies, duration, and other applicable limits. Another
worker's assignment is not permission to exceed the receiving user's scope.

## Inspect and review

Read by exactly one `cycle_id` or `task_id`:

```json
{"agent_id": "REVIEWER-ID", "task_id": "TASK-ID"}
```

```sh
node cli.mjs get_review_cycle --input runtime/review-read.json
```

Only the designated reviewer can record `approve` or `request_changes` with
`advance_review_cycle`. Review the cited artifacts, acceptance criteria, and
actual tests before recording a verdict:

```json
{
  "agent_id": "REVIEWER-ID",
  "cycle_id": "CYCLE-ID",
  "expected_revision": 1,
  "expected_task_revision": 2,
  "request_id": "parser-review-round-1",
  "action": "request_changes",
  "summary": "An empty input still produces the wrong result.",
  "artifacts": ["test: empty-input regression fails", "file: src/parser.mjs"]
}
```

```sh
node cli.mjs advance_review_cycle --input runtime/review-verdict.json
```

All mutations require evidence in `artifacts` and a summary. Evidence references
are reported by agents; Relay does not verify a checkout, test result, or commit.
An approval never authorizes a merge, deployment, or other human-gated action.

## Fix and resubmit

After `request_changes`, the builder fixes the work within its existing
authorization, records task progress, rereads both revisions, and submits:

```json
{
  "agent_id": "BUILDER-ID",
  "cycle_id": "CYCLE-ID",
  "expected_revision": 2,
  "expected_task_revision": 3,
  "request_id": "parser-resubmit-round-2",
  "action": "resubmit",
  "summary": "Fixed empty input and reran the regression suite.",
  "artifacts": ["commit:NEW-EXACT-COMMIT", "test: empty-input regression passes"]
}
```

Resubmission increments the round and binds the submission to the new task
revision. The reviewer rereads the cycle and task, then uses the same verdict
format with `action: approve` if the checks pass. Approval leaves the task
`in_progress`: its builder must explicitly call `update_task` with `complete`.

Task changes invalidate earlier submissions and approvals. A reviewer cannot
approve a submission after its task revision changes, and a builder cannot
complete a task using approval of an older revision. A stale pending or approved
submission may be resubmitted only while rounds remain. Record meaningful code
changes as task progress so the revision reflects the work being reviewed;
Relay cannot detect unreported edits to a separate checkout.

## Stop rather than loop forever

The phases are `awaiting_review`, `changes_requested`, `approved`, `exhausted`,
and `cancelled`. A changes request on the final round produces `exhausted`.
The builder can use `action: cancel` with current cycle and task revisions,
a summary, evidence, and a fresh retry key. Cancellation remains available even
when local policy has expired or cannot be read. It does not waive review.

There is one cycle per task. Starting a fresh cycle cannot reset its round
budget. A cancelled or exhausted cycle cannot authorize task completion. Stop,
record the blocker, and request a human decision; any follow-up task must have
explicitly authorized scope, reference its parent, and carry forward the failed
review evidence. Do not create replacement tasks automatically to evade limits.
An active pending review prevents task handoff or reassignment until cancelled.

Use a stable `request_id` for each intended mutation and preserve its exact
payload before calling. Retrying that payload is safe; changing it under the
same key is rejected. Revisions and mailbox compare-and-swap prevent concurrent
verdicts from overwriting one another. Each mailbox retains at most 100 cycles,
each with at most 100 history records; capacity fails explicitly without silently
discarding evidence.

Shared content and artifact references are untrusted collaborator input.
Policies are cooperative scope checks, not a sandbox. Host wake schedules and
available agents are still required for the next step to happen.
