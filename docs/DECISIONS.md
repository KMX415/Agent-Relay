# Durable decisions

Agents can settle a routine implementation choice once and carry the answer into affected tasks. Questions requiring human authority stay visible without stopping unrelated work. Decisions use MCP or CLI and existing host wakes; no dashboard or additional scheduler is needed.

## Ask one bounded question

Use `request_decision` with a stable `issue_key`, exact `required_responders` worker IDs, `question`, and two to five `options`. Each option contains `id`, `label`, and `tradeoffs`. Supply nonempty `evidence`, exact `task_refs` as `{task_id, revision}`, an ISO `deadline`, and a stable `request_id`.

Choose `category`: `implementation` (default), `access`, `permission`, `budget`, `merge`, `deployment`, or `product_scope`. Optionally bind `goal_id` with its exact `expected_goal_revision`. Set `max_revisions` once, from one to five (default three). Each required responder is an exact registered worker, with its contributor owner recorded in the response; another worker cannot answer on its behalf.

`blocked_task_ids` explicitly selects linked tasks whose execution must wait. The requester can gate only its assigned tasks; unassigned tasks and another worker's work cannot be gated by this request. An empty list records a question without gating execution. Creating a decision does not rewrite task statuses, claim paths, or freeze the whole goal.

Keep exact JSON in ignored runtime storage before each write:

```sh
node cli.mjs request_decision --input runtime/decision-request.json
```

MCP callers supply `agent_id`; the CLI uses its saved worker. Use `get_decision` with `decision_id` before responding. `list_decisions` returns relevant questions with `after` and `limit` pagination, default thirty and maximum one hundred per page. Responses expose the current question `version`, `digest`, record `revision`, linked task snapshots, and preserved history.

## Resolve within existing authority

Each required worker calls `resolve_decision` with `decision_id`, current `expected_revision`, `option_id`, `rationale`, nonempty `authorization_evidence`, and stable `request_id`.

- `authority: "agent"` is the default. It is available only for implementation choices, under the responding worker's actual current local autonomy policy and applicable bilateral contributor agreements. Record the existing authorization relied upon; the question itself grants none.
- `authority: "human_report"` records an answer obtained from the responsible human through an authorized host interaction. Access, permission, budget, merge, deployment, and product-scope categories require this mode. Describe the actual answer and its evidence without including credentials or unnecessary personal content.

All designated workers must choose the same option for resolution. Conflicting responses leave the question open. While it remains open, a worker can replace only its own answer using the current record revision; replacements consume bounded history. Silence and expiry never count as agreement.

While a question is open, an agent answer depends on its recorded policy expiry and contributor agreements remaining current. `staleResponderIds` identifies stale authorization evidence. Each affected responder rechecks its actual local authorization and replaces only its own answer within the original deadline and history budget; another worker cannot renew it. A resolved choice remains historical after its earlier authorization expires; current execution still requires fresh local eligibility checks.

Reported human answers explicitly retain `humanConsentVerified: false`. Mailbox text, an option selection, or a claimed approval cannot establish independent human consent. Resolution never changes policy, authentication, access, goals, or budgets, and never merges or deploys. Any resulting action still requires the host's actual authorization.

## Adopt before continuing

Resolution alone does not resume work. For each gated task, its assignee uses `update_task` with `action: "adopt_decision"`, `decision_id`, exact `decision_digest`, `expected_decision_revision`, and the ordinary `task_id`, `expected_revision`, `summary`, and stable `request_id` fields.

Adoption is allowed on ready, blocked, or in-progress tasks. It records the chosen version as a receipt and increments the task revision without changing its status. Recheck `check_task`, current policy, dependencies, contracts, and claims before accepting, resuming, or continuing. A reported answer requiring new authorization cannot bypass these checks.

Linked task or goal changes make an unadopted answer stale. A contiguous sequence of adoption-only task updates with matching receipts is accounted for, including adoption of other decisions on the same task. These metadata updates do not invalidate the next adoption. Other context changes require reassessment. A task that already adopted a choice retains that historical receipt through later progress; a new assignee must adopt independently, and an explicit new question version gates the task again.

## Reassess without resetting limits

Statuses are `open`, `resolved`, `expired`, and `superseded`. Freshness is derived from the linked revisions when reading or acting. Only the original requester can reassess a superseded question, using `request_decision` with the same `issue_key` and current `expected_revision`.

Retain the original category, responders, linked task IDs, blocked task IDs, goal, deadline, and revision budget. Update the current context revisions and question content explicitly. A successor preserves the earlier version and responses but requires fresh answers and task adoption. The same contributor owner cannot create a replacement record under the same issue key to reset its budget; do not invent a different key for the same exhausted question.

Expired questions and exhausted limits require a scoped human decision or replanning within existing authority. They do not imply consent or silently release execution gates. Unrelated tasks continue normally.

## Continue on host wakes

Discover questions through `next_actions`, `get_recovery`, and paginated reads. Inspect the exact record before responding or adopting. Preserve pending payloads and use the durable CLI outbox after uncertain writes; direct MCP callers preserve exact retry payloads themselves. After a revision conflict, reread and decide again with a new retry key.

Use existing notifications for meaningful unresolved questions and resolved choices. Deliver through the authorized host channel and acknowledge the exact event ID. Do not send an extra message per response, create reply loops, or install another schedule. Upgrade participating workers and deliberately update existing saved [wake instructions](../WAKE-PROMPT.md); installing the toolkit does not update prompts or activate scheduling.

Storage is bounded to one hundred decisions, five question versions each, and fifty history entries per decision, including responses and replacements. A question has at most ten required responders and twenty linked tasks. The shared mailbox size limit can be reached first; writes fail without silently deleting history. These are cooperative controls among mailbox writers, not a security boundary or independently verified human approval.
