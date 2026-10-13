# Team acceptance harness

Dead Drop's target is collaboration across people and agents without a human relaying
every turn. Multiple sessions under one person's account do not establish that
result. This harness tests contributor workflow boundaries before external
testers are available, and preserves that distinction in its reports.

## Run

```sh
npm ci
npm run test:team
```

The default run creates six scripted workers, two for each of three synthetic
contributors. Each has a saved identity, local policy, and workspace. All use the
public Dead Drop dispatcher against a local persisted compare-and-swap store. No
configured GitHub mailbox, saved real worker, scheduler, or dashboard is used.
At most three tool calls execute concurrently.

Every run gets a fresh directory under ignored `runtime/team-harness/`. The CLI
prints its location and report, and exits unsuccessfully if a scenario fails.
`report.json` includes scenario evidence, actual elapsed time, write/conflict
counts, injected faults, completed tasks, and expected human-decision conditions.
These conditions count simulated blockers, not actual human interventions.

## Scripted scenarios

| Scenario | Checked behavior |
| --- | --- |
| Contributor ownership | A different injected login cannot act as another contributor's worker |
| Different local scopes | Assignment cannot override the receiver's allowed paths |
| Lost response and retry | Saved exact payload survives restart; retry produces one message |
| Concurrent writes | Three writers retain their messages after a CAS conflict |
| Advisory claims | A cooperative worker skips an overlapping edit and retries after release |
| Offline routing | Unaccepted delivery exhausts a fixed budget; accepted work is not taken over |
| Checkpoint recovery | Rebinding a worker reloads its saved identity and checkpoint |
| Review exhaustion | A bounded review blocks completion and rejects resetting the same task's budget |
| Artifact and skill reuse | A seeded Node fixture fails, a scripted correction passes, and another contributor applies the reviewed technique to new inputs |

The fixture review verdicts and corrections are scripted. Actual Node assertions
run, but this mode does not measure autonomous reasoning or learning. Restart
means rebinding the worker against saved state, not restarting the operating
system. Network failures and time passage are injected locally.

## Optional real-model exercise

```sh
npm run test:team:live
```

This also launches six bounded Claude Code sessions using the installed `claude`
CLI and existing local authentication. It consumes provider usage. Each session
has a three-minute default timeout and a bounded tool/output budget. Sessions run
serially so later workers can inspect earlier results.

Workers implement, review, test, capture a skill, review that skill, and reuse it.
They receive an identity-bound MCP connection and fixed fixture tools, without
native shell or filesystem tools. The artifact is declarative normalization JSON;
the parent evaluates it rather than executing model-generated code. Publication
is performed by the harness as the creator only after an actual model approval.
The final report requires observed tool activity, cross-contributor skill review,
publication, a passing reuse artifact, and a recorded reuse outcome. Successful
provider exits alone do not pass the exercise.

Provider results stay in each ignored worker directory. Usage is reported when
the provider supplies it; missing usage is unknown, never zero. Do not publish
runtime records or provider output as part of the source repository.

## What remains unproven

On October 12, 2026, all nine scripted scenarios and the optional six-session
Claude exercise passed. The live verifier observed passing tests of the same
artifact digest by the implementer and reviewers, an addressed review request
with its linked answer and acknowledgement, independent skill approval, and
tested reuse. These are results for this bounded synthetic configuration task.

Synthetic owners are injected application contexts, not separate authenticated
GitHub accounts or humans. Separate directories and MCP capabilities are not OS
sandboxes. The live exercise uses one provider account, local storage, and manual
process launches; it does not test provider diversity, host schedules, GitHub
permissions, independent project priorities, or measured productivity gains.

The next external acceptance run needs independent contributors with their own
accounts, authorization, projects, and schedules. Their agents should discover
work, negotiate scope, exchange an actual review, and reuse a lesson without
either human carrying messages. Record declined work and required decisions as
carefully as successful handoffs.
