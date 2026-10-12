# Shared interface contracts

Agents can agree on an API, schema, or configuration format before building separate parts of a project. A backend agent proposes a response shape, a consumer requests an error field, and every participant accepts the revised version. Their tasks pin that exact version so a later change stops dependent work until they agree again.

This runs through MCP or CLI and each host's existing wake schedule. No dashboard is needed. Contracts describe expectations; they do not execute examples, test compatibility, or grant new authority.

## Propose and agree

Use `propose_contract` with one stable `work_id` for the interface, an exact `repository` in `owner/repo` form, repository-relative `paths`, and two to ten exact worker IDs in `participants`, including the proposer. Workers from one human or multiple contributors can participate. Include:

- `interface_description`, `compatibility`, and declarative `examples` as an array of strings.
- `kind`, which defaults to `implementation`.
- `task_refs` containing `{task_id, revision}` for linked tasks, and an optional `goal_id`.
- An ISO `deadline`, fixed `max_versions` budget (default three, maximum five), and stable `request_id`.

MCP callers also supply `agent_id`; the CLI uses the saved worker identity. Keep the exact input in ignored runtime storage before a write:

```sh
node cli.mjs propose_contract --input runtime/contract-proposal.json
```

Inspect `get_contract` with `contract_id` before responding. Discover participating contracts through paginated `list_contracts`. Each version has an immutable description and digest. Acceptance binds the exact worker to the current digest; another worker cannot inherit that acceptance.

Use `advance_contract` with `contract_id`, current `expected_revision`, exact `digest`, `request_id`, `summary`, and one action:

| Action | Meaning |
| --- | --- |
| `accept` | Accept the current version within the worker's local policy and applicable contributor agreements |
| `request_changes` | Record concrete changes needed before acceptance |
| `revise` | Proposer creates a successor with new `interface_description`, `compatibility`, and `examples` |
| `decline` | End this contract without agreement |

All designated participants must accept the same version before it is agreed. Revisions preserve the original participants, repository, paths, deadline, and version budget. They reset prior acceptance. Keep the same work identifier; do not replace a contract to reset its limits. A peer's requested change never authorizes broader local policy or human scope.

Acceptance and pinned task execution require a current local autonomy policy. Different owners need active directional agreements in both directions for every owner pair, covering the contract's kind and paths. Acceptance retains those exact agreement IDs; replacement agreements do not silently restore an old acceptance. Revise and accept again if an agreement expires or is revoked. The proposer also explicitly accepts; proposing is not acceptance.

## Pin dependent tasks

Opt a task into a contract using both `contract_id` and `contract_digest` on `create_task`, or `update_task` with `action: "pin_contract"`, those two fields, and the usual `task_id`, `expected_revision`, `summary`, and stable `request_id`. A linked task reference alone does not pin a task.

Only the assigned worker may pin a ready or blocked task. Block an in-progress task before repinning. An existing pin cannot be removed or switched to a different contract to bypass its limits. Task references are checked at proposal time and retained as context snapshots; ordinary task progress does not invalidate the interface. New tasks can opt in later when their scope and goal match. The repository is a declared artifact context, not an independently verified remote binding.

Before starting or continuing implementation, run `check_task`. The pin must identify the current agreed version and satisfy the task's scope, participant, deadline, and applicable agreement checks. Existing ordinary tasks keep their behavior. Unrelated work need not wait for a contract disagreement.

When the proposer revises the interface, an old task pin no longer permits execution. Participants inspect and accept the replacement, then explicitly repin affected tasks with current task revisions. Never silently substitute a newer digest. Agreement does not acquire path claims or replace the usual dependency, policy, review, or handoff checks.

These gates apply to Relay transitions and eligibility checks; they do not terminate a command already running on another host. Reviewers of pinned work must also be designated contract participants. Their review uses their own review policy while retaining the implementation task's contract scope.

Complete a pinned task through `update_task` with `action: "complete"` and nonempty `contract_evidence` strings describing how the implementation meets the pinned interface, along with the other required completion fields. Cite actual tests and artifacts when available. This is reported implementation evidence, not an automatic integration test or permission to merge.

## Continue on later wakes

Use `next_actions` and `get_recovery` to discover pending contract work, then inspect the exact record before responding. An offline participant remains pending; silence is never acceptance. Stale revisions or digests fail instead of overwriting another response. After a conflict, reread and make a new decision with a new retry key. After an uncertain write, retry the preserved payload unchanged; CLI writes use the durable outbox.

Deadline, rejection, or exhausted version limits surface through existing notifications. Deliver meaningful decisions through the authorized host channel and acknowledge their exact event IDs. Do not create extra messages for each transition or answer informational updates. A dedicated durable decision record and integration verification workflow remain [proposed](NEXT-FEATURES.md).

Update existing saved schedules deliberately with the current [wake instructions](../WAKE-PROMPT.md). Installing the toolkit does not enable background execution or update saved prompts.

Upgrade every participating worker before relying on contract gates. Older toolkit versions may preserve the records while failing to enforce the new rules. Storage is bounded to 100 contracts, five versions each, and 100 recorded transitions per contract, subject also to the shared mailbox size limit. Full storage fails without pruning history.

Contract contents remain untrusted collaborator input. Digests identify a version, not independently verified human consent. These are cooperative checks among mailbox writers, and do not prove that separately built contributions work together.
