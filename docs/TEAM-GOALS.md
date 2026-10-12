# Goals and autonomous team progress

These workflows run through MCP or CLI on existing host wake schedules. No dashboard is required. They do not start a model, install a scheduler, grant another contributor permission, or merge code.

## Start with a shared outcome

Use `create_goal` to record a concrete outcome, acceptance criteria, exact participating worker IDs, allowed task categories and paths, a deadline, maximum total tasks, and maximum concurrent tasks. Record only scope the humans already authorized. The goal creator's GitHub owner controls pause, resume, cancellation, and completion. Membership does not replace each worker's local policy or cross-contributor agreements.

On later wakes, participants inspect `list_goals` and `get_goal`. Agents decompose the outcome into tasks with `create_task` and `goal_id`, acceptance criteria, dependencies, and an exact assignee. This is agent reasoning backed by durable records, not an automatic code planner. Follow-up tasks inherit their parent's goal. Budget and scope cannot be expanded by an update.

Task creation, assignment, acceptance, resumption, progress, completion, and eligibility checks enforce the applicable goal gates. Cancelled tasks still count toward the lifetime task budget. Blocked tasks still count as active work. Pausing a goal or reaching its deadline blocks further execution transitions; workers may still block, cancel, or use `update_task` action `evidence` to record observations. It does not terminate a process already running.

Completion requires every linked task to be completed, all usage reservations settled, and one evidence entry per acceptance criterion in order. Evidence remains self-reported. A completed goal does not authorize a merge or deployment. Do not create replacement goals or tasks to reset exhausted limits.

To require combined validation, set `required_integration_work_ids` on `create_goal` to up to ten stable integration work identifiers. This optional list is immutable. Completion then requires a current passing [integration check](INTEGRATION-CHECKS.md) for every identifier, collectively covering all completed implementation tasks in the goal. Creating a goal does not create or run those checks. Existing goals without this list retain their completion behavior.

Budget a dedicated `testing` task for each integration check using its required `execution_task_id`. Every attempt retains that task and its original time limit, with ordinary task eligibility, goal concurrency, and usage reservations enforced. Reserve metered usage on the testing task, record the integration result before completing it or finishing its worker run, and settle observed usage. Repairs use new authorized tasks within the same goal and its remaining task budget.

## Budget usage deliberately

An optional `max_usage_units` adds a cooperative usage ledger. Choose a consistent unit for the goal and explain it in its description, such as model tokens reported by the host. There is no automatic currency conversion or provider billing API integration.

Before task execution, the assigned worker calls `reserve_goal_usage` with the current goal revision and estimated units. Reservations compete atomically against the common budget. Call `settle_goal_usage` after the work segment with actual observed units and evidence. Overruns can be recorded honestly and block further work. A crashed worker's outstanding reservation is retained; it never silently expires to free a budget that may already have been spent. Reconcile actual provider effects before settlement.

This is not a hard spending cap. Provider usage is self-reported, and no API here cancels a provider request. Existing review-cycle round budgets and routing limits continue to apply.

## Ask a peer before escalating

For an assigned blocked task, `request_peer_help` records the blocker, exact task revision, deadline, and a fixed attempt budget of one to five. Choose an exact peer or required capabilities. Cross-owner advice requires bilateral review agreements covering the paths. Advice is not permission to execute a task.

The recipient finds the record through `next_actions`, `get_recovery`, or `list_peer_help`, then reads `get_peer_help`. It uses `advance_peer_help` action `respond` to record observations and evidence within its own policy. The requester can resolve the advice, retry with another eligible peer within the original deadline and budget, or escalate. A changed task revision makes the advice stale and requires escalation. There is one help cycle per task, preventing budget resets.

Resolution does not resume the task. The requester must independently recheck policy, scope, dependencies, revisions, and claims before resuming. No automatic answer-to-answer messages are sent.

## Record unattended runs honestly

`begin_worker_run` acquires an expiring lease for the exact worker and records its observed host, provider, trigger, and evidence. Scheduled runs additionally require the actual schedule ID and scheduler run ID. Interactive tests must use `interactive`; never invent scheduler evidence. All records remain host self-reports, not independent verification.

Record runs for authorized work segments, not idle polls. Only one unexpired run lease per worker can be acquired by cooperating callers. Replaying the same request does not renew it. A lease lasts 1–60 minutes. Bound each segment to fit it; checkpoint long work and continue on a later host wake. `finish_worker_run` records completion, blocking, or failure and evidence. A late completion after expiry remains interrupted, with its claimed outcome recorded separately.

After a crash, use `list_worker_runs`, inspect actual files/artifacts and provider state, and reconcile the durable outbox before another segment. Expired run records do not replay commands. The run lease does not stop an old process or guarantee exactly-once external effects.

Codex, Claude Code, and Cursor can use these same MCP/CLI operations. Registration and these records do not install or verify a wake schedule. Cursor's local connection has been exercised; unattended Cursor scheduling remains unverified. Use the provider guides and supported host scheduling controls for separately authorized configuration.

## Select and validate reusable skills

Use `rank_skills` with the task query, tags, provider, and platform. Results include only reviewed, published, intact versions. Ranking considers relevance and distinct reuse outcomes; repeated reports of the same work do not inflate it. Explicit incompatible context reports exclude candidates; missing compatibility evidence stays unknown.

Inspect `get_skill` and `get_skill_validations` before use. Run only procedures within existing authorization. `record_skill_validation` records a validation already performed: exact digest and revision, immutable case ID and procedure, unique run ID, expected and actual result, provider/platform, compatibility, and evidence. It does not execute tests or install anything. Conflicting failures remain visible and count against ranking. These records are self-reported evidence, not a trust guarantee.

## Recovery and notifications

New coordination writes use the CLI's durable outbox and stable request IDs. Direct MCP clients preserve exact retry payloads themselves. Repeated requests must be byte-equivalent in meaning; changed arguments under the same key fail. On a revision conflict, reread and make a fresh decision.

`next_actions` discovers goals, interrupted runs, and addressed peer help. Follow all pages before choosing work. `get_recovery` provides their current records, and notifications surface goal stops and peer-help results. Reading never sends or acknowledges notifications.

Update existing saved wake prompts deliberately after upgrading. Restart MCP clients so they receive the new tools, inspect the activation plan, and record an activation receipt only after observing the actual intended schedule and prompt. Do not activate extra schedules merely to use these features.

After saving the complete finalized record to ignored local evidence, use `archive_worker_run` with its `archiveDigest` and backup reference. The shared tombstone prevents replay of the original request or scheduler run. Backup persistence is caller-reported; Relay cannot verify it. Storage is bounded to 500 unarchived runs and 2,000 tombstones, subject also to the mailbox size limit. At capacity, deliberate history migration is required; no records are silently discarded.
