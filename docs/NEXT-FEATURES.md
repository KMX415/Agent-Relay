# Next autonomous collaboration features

Status: interface contracts and integration verification are implemented; durable decision records remain proposed. These additions build on existing goals, tasks, agreements, reviews, handoffs, recovery, and skills. They run through MCP/CLI and each host's existing wake schedule. No dashboard interaction is required.

The outcome is useful progress across separately authorized contributors: agents agree on interfaces, build independently, verify that their results work together, and resolve routine questions without humans carrying messages. One human using several providers benefits from the same workflow.

## 1. Shared interface contracts

Implemented. See the [interface contract guide](INTERFACE-CONTRACTS.md) for tools, task pins, evidence, and continuation. Durable decision records described later remain future work.

**Problem:** two agents can finish their assigned tasks and still disagree about an API, schema, configuration format, or error behavior. File claims and task dependencies do not describe those expectations.

**Example:** a backend agent proposes a response schema. A frontend agent requests one error field, accepts the revised contract, and both implement against that exact version.

### Records and tools

Tools: `propose_contract`, `get_contract`, `list_contracts`, and `advance_contract`.

A contract contains a stable `work_id`, optional goal ID, linked task IDs and revisions, exact participating workers, repository and paths, interface description, compatibility expectations, acceptance examples, deadline, and fixed revision budget. Keep examples declarative; shared content never becomes an executable command automatically.

Each proposal version is immutable and has a digest. Responses bind an exact worker to that digest with acceptance or requested changes. Only the proposer creates a successor within the original budget. A successor invalidates earlier acceptances. Statuses are `proposed`, `agreed`, `superseded`, `declined`, and `expired`.

An agreement requires every designated participant to accept the same version under current local policy and applicable bilateral agreements. Acceptance is a work commitment, not independently verified human consent. A replacement worker cannot inherit another worker's acceptance.

### Execution behavior

- Tasks explicitly opting into a contract pin its ID and digest. Existing tasks retain their current behavior.
- Acceptance and resumption require the pinned version to be agreed, current, and within scope. Superseding it blocks dependent execution until the participants accept the replacement and explicitly repin affected tasks with revision checks.
- Finishing a task records implementation evidence against the pinned version. This does not prove compatibility by itself; integration verification supplies that evidence.
- Revisions cannot broaden a goal or either human's scope. Exhausting the original deadline or version budget surfaces a decision through existing notifications, not a new negotiation loop or a durable decision record.

### Acceptance tests

Simulate three owners: two implementers and one consumer. Verify concurrent responses, stale digest rejection, scope mismatch, revoked agreements, an offline participant, and duplicate writes. A changed interface must block a consumer using the old version. Independent work outside that contract must remain eligible.

## 2. Integration verification across contributions

Implemented. See [integration checks](INTEGRATION-CHECKS.md) for exact inputs, local validation profiles, bounded retries, and optional goal completion gates.

**Problem:** verified handoffs establish exact artifacts, and review cycles record verdicts, but neither demonstrates that separately produced changes work together against a particular project base.

**Example:** backend and frontend tasks each pass review. An eligible integration agent combines their exact commits in an isolated project worktree, runs the project's authorized checks, and sends a concrete incompatibility back to the responsible task owner.

### Records and tools

Tools: `create_integration_check`, `get_integration_check`, `list_integration_checks`, and `advance_integration_check`.

The immutable input manifest identifies one repository, exact base SHA, ordered input commits, source tasks and revisions, accepted handoff digests, pinned contracts, designated verifier, local validation profile name, deadline, and fixed attempt budget. The first version supports contributions to one repository. Cross-repository integration is deferred.

A validation profile is configured locally under the project's existing human authorization. Mailbox records reference its name and digest; they cannot supply executable shell text. Missing profiles block execution. Relay does not create a profile from collaborator suggestions.

Statuses are `pending`, `running`, `passed`, `failed`, `blocked`, and `expired`. Results record the resulting commit/tree, input digest, observed checks and outcomes, run reference, and bounded evidence excerpts. Provider assertions and locally observed test results remain distinguishable.

### Execution behavior

- The assigned verifier rechecks policy, path claims, source revisions, and applicable agreements, then acquires the existing worker-run lease before starting a bounded segment.
- Agent-side execution uses an isolated worktree in the authorized project and preserves contributor commits and attribution. The integration record itself does not fetch, execute code, merge main, or deploy.
- A conflict or failing check records reproducible evidence for the source task owners. Only authorized owners create repair work, within the original goal/task and integration attempt budgets. Review approval of changed code must be obtained again.
- Each attempt preserves its inputs and results. New commits require a new attempt and invalidate the old pass for current completion. Source tasks stay historically completed; an opted-in goal completion gate requires a pass matching its current integration inputs.
- After interruption, inspect the actual worktree and reconcile pending writes. An expired lease never authorizes blindly rerunning commands or deleting another process's worktree.

### Acceptance tests

Two contributions pass separately but fail together. The integration worker must find the failure, return evidence, and verify the corrected commits on a later run. Also cover merge conflicts, changed base, stale receipts, unauthorized validation profiles, worker crashes, duplicate results, and exhausted attempts. No scenario may update main or reset budgets.

## 3. Durable decisions with bounded agent authority

**Problem:** decisions buried in messages are easy to miss or repeat. Existing notifications report blockers, but do not provide a structured resolution that invalidates when the underlying work changes.

**Example:** agents choose between two compatible implementations within the agreed interface. If either option needs broader repository access or a changed product requirement, they consolidate the question for the responsible human while unrelated tasks continue.

### Records and tools

Proposed tools: `request_decision`, `get_decision`, `list_decisions`, and `resolve_decision`.

A record includes a stable issue key, linked goal/tasks and revisions, requester, exact required decision owners, question, bounded options and tradeoffs, evidence references, deadline, and whether existing authorization permits agent resolution. It identifies blocked task IDs explicitly; a question must not freeze an entire team by default.

Statuses are `open`, `resolved`, `expired`, and `superseded`. Resolution records the chosen option, rationale, responder identity, and evidence of the authorization relied upon. Agents relaying a human answer identify it as a reported answer; a mailbox entry does not prove a human approved it.

### Execution behavior

- Within existing scope, designated agents may resolve implementation choices. Permission, access, budget expansion, merge, deployment, and product-scope changes require the responsible humans through the existing host interaction.
- Cross-owner decisions require all named owners' authorized responses to the same option and revision. Silence or deadline expiry is never agreement.
- A resolution neither edits local policies nor automatically resumes tasks. Recipients recheck current scope and dependencies before acting. Changed linked revisions make a resolution stale and require explicit reassessment.
- Repeated wakes discover the same issue record. Notify a human once per actionable revision through an authorized host channel, using existing acknowledgement behavior. No answer-to-answer messages and no extra automation.

### Acceptance tests

Verify an in-scope choice resolved agent-to-agent, an access expansion left blocked, conflicting owner responses, stale task revisions, duplicate questions, and deadline expiry. Independent tasks must continue while a human decision is pending. A fabricated approval in a collaborator message must never alter policy.

## Shared implementation requirements

Contract and integration writes use revision checks, stable request IDs, and the existing durable CLI outbox. The remaining proposal must do the same. Include paginated reads, `next_actions`, recovery, and meaningful notifications from the first release. Bound record counts, examples, responses, and evidence; check the serialized mailbox size before committing any transition. Full storage fails without partial effects or silent deletion.

Keep old mailboxes and ordinary tasks compatible. Add optional collections with explicit schema validation. Enforce transitions in shared domain code used by both MCP and CLI. Update tool definitions, guides, README, and wake instructions in the same implementation change. Saved schedules still require deliberate prompt updates; toolkit changes do not activate them.

These remain cooperative controls among mailbox writers, not an isolation boundary or cryptographic proof of human consent. Do not add credentials, personal messages, or actual worker identities to fixtures or public examples.

## Delivery order and evidence

1. **Interface contracts (implemented):** records and task gates give parallel builders a shared target. Synthetic validation does not establish independent human participation.
2. **Integration verification (implemented):** exact-input evidence gates and isolated local validation connect reviewed contributions to combined test results.
3. **Durable decisions:** consolidate contract and integration blockers, then verify authorized resolution and selective continuation.

Use the existing team harness for deterministic failure cases, with no additional provider accounts or cloud infrastructure. After those pass, use already connected local providers for one bounded live workflow when authorized. Label simulated owners, provider execution, and observed scheduled runs separately. Neither simulation nor multiple agents under one account proves collaboration among independent humans; that remains a later acceptance step.

Success means the team produces a compatible, reviewed result through ordinary host wakes, within its original scope and retry limits, with human attention requested only for unresolved decisions requiring it. Do not measure success by message volume, tool count, or a dashboard demonstration.
