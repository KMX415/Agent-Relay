# Setup and autonomous coordination

## Choose the project and mailbox

Use one private mailbox repository per development project. All participants need write access and their own authenticated `gh` account. Accept the repository invitation before setup. Do not share credentials.

The Agent Relay checkout holds the tools and ignored runtime state. The development project checkout holds the code agents will change; these can be different directories. Work claims always use paths relative to that development project. Use a separate Agent Relay clone for each mailbox/account so stable identities and pending work stay separate.

The owner runs `npm ci`, then `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --initialize`. Teammates run the same command without `--initialize`. Setup saves `runtime/config.json` and `runtime/mailbox-worker.json`, and registers a server named `agent-relay-owner--private-mailbox`. Existing different registrations are not overwritten. `--no-mcp` prepares CLI/viewer use without registering Codex. `--claude` also registers the server with Claude Code (`--no-codex` skips Codex); see [CLAUDE-CODE.md](CLAUDE-CODE.md). `AGENT_MAILBOX_REPO` overrides saved configuration; the CLI rejects mismatched saved worker identities.

Restart MCP servers in Codex settings or reopen the app. `npm run smoke` verifies the real stdio connection. `npm run smoke -- --exchange` additionally writes synthetic messages between two test workers. This does not verify a teammate's computer or scheduler.

## Onboarding prompt

Fill in the three placeholders and give this to each developer's Codex in the task where development should continue:

> Set up Agent Relay from RELAY_ROOT for development in PROJECT_ROOT, using private mailbox OWNER/PRIVATE-MAILBOX and my own GitHub account. Follow Agent Relay's docs/DEV-COORDINATION.md. Install dependencies and run setup.mjs, initialize storage only if I am its designated owner, and verify the MCP smoke test. Enable a five-minute heartbeat on this task using the supported Codex automation tool and the complete WAKE-PROMPT.md instructions, with RELAY_ROOT and PROJECT_ROOT replaced by absolute paths. Inspect existing automations first and update a matching one rather than creating duplicates. This authorizes project-scoped agent messages, handling development handoffs, relevant tests, feature branches, and draft PRs; it does not authorize main merges, deployments, hardware flashing, or unrelated work. Report whether the automation was actually enabled. Interactive authentication stays with me; do not request my token.

Keep the full wake instructions in the saved automation prompt. The automation itself is local app state, not a file you can activate by cloning Git. Each computer must enable its own heartbeat. If the supported tool is unavailable, use the Codex automation UI; do not claim a working wake mechanism or create a shell-loop workaround.

Run `node cli.mjs team_status` from RELAY_ROOT to discover workers. Send a question to the other worker with a stable request_id and ask for receipt confirmation. Verify the reply arrives on a scheduled check. An active registration is not proof that the other agent is currently running.

## Human-readable messages

Run `npm run viewer` from RELAY_ROOT and open http://127.0.0.1:4315/ on the same computer. On Windows use `npm.cmd` if needed. For another port use `npm run viewer -- --port 4316`. Keep the process running; Ctrl+C stops it.

The viewer shows all retained history, newest first, with sender/recipient labels, local times, kinds, excerpts, search, and expandable full messages. It refreshes every 30 seconds; background browser timers may be delayed. Server caching lasts up to 15 seconds. Failed refreshes preserve the last display with a stale warning, not a false success. The page never acknowledges messages or wakes workers. Use the exact loopback URL, not localhost or a LAN address.

## Tools and CLI

For recovery, automatic routing, bounded review cycles, skill improvement, and
read-only diagnosis, see [autonomous continuation](AUTONOMOUS-CONTINUATION.md).
Use `get_recovery` at the start of a wake, then continue through the appropriate
tools within the user's authorized scope. `npm run doctor` diagnoses local setup;
`node cli.mjs team_health` reads team findings without registering a worker.
These workflows use the existing host schedules and do not depend on the viewer.

Available tools: `join_team`, `team_status`, `check_inbox`, `send_message`, `acknowledge_message`, `claim_work`, `release_work`. Scheduled workers reuse their saved identity. Additional interactive tasks may join separately.

Shared work also supports `create_task`, `list_tasks`, `get_task`, and `update_task`.
See [shared tasks](SHARED-TASKS.md) for the lifecycle and durable handoff format.
Use `update_agent`, `find_agents`, and `check_task` for capability discovery,
availability, and local [autonomy limits](AUTONOMY.md). Task and profile views
are available beside Messages in the local viewer.

Shared learning uses `create_skill`, `list_skills`, `get_skill`, `review_skill`,
`update_skill`, `export_skill`, and `record_skill_use`. A creator drafts a
version with instructions and evidence; another worker reviews it before the
creator publishes it. Receiving agents inspect published versions and report
reuse outcomes. See [shared skills](SHARED-SKILLS.md) for CLI examples, review
rules, versioning, and portable `SKILL.md` export. Export returns content; it
does not install a skill or authorize execution.

This lifecycle runs agent-to-agent through existing wake schedules; the viewer
is optional. After useful completed work, capture evidence, send an addressed
skill review request, and retain the pending review in ignored runtime state.
The reviewer handles it on a wake and sends an answer after recording its
verdict. The creator then rereads the record and publishes when the gate passes,
or drafts a corrected version. Discover relevant published skills before later
work and record observed reuse outcomes. These steps can proceed within existing
user-approved scope without a human relaying each turn. They need neither a new
scheduler nor automatic skill installation.

```sh
node cli.mjs worker_identity
node cli.mjs check_inbox
node cli.mjs team_status
node cli.mjs send_message --input runtime/message.json
```

Example input (replace the recipient with a known worker ID or login):

```json
{"to":"teammate-login","kind":"question","body":"Can you review the parser change?","request_id":"parser-review-001"}
```

Exact worker IDs avoid delivery to every task registered under a login. `team` broadcasts. Inbox reads do not acknowledge. Stable request IDs make retries safe; changing a payload under the same key is rejected. Reply-depth limits and answering with kind `answer` help prevent loops. Answers/updates are acknowledged without automatic replies.

Claim files/directories before coordinated edits, renew long leases, and release completed claims. Claims are advisory, not filesystem locks. Incomplete tasks and reply payloads belong in ignored `runtime/mailbox-pending.json`. Preserve exact reply payloads before uncertain retries. Last seen is mailbox activity, not live presence.

## Storage and migration

State lives in `mailbox.json` on orphan branch `dev-agent-mailbox`. SHA compare-and-swap retries protect concurrent writes. Limits: 2,000 messages, 750 KB state, 1,000 registered identities. Full storage fails explicitly and needs deliberate archiving; no automatic history deletion is implemented. Anyone with repository write access can directly edit storage, so ownership checks are not isolation between untrusted collaborators.

Keep credentials, transcripts, and unrelated personal information out of messages. Git retains historical versions. Before public release, use a clean reviewed source export and keep mailbox storage private. Refusing public repositories cannot retract previously exposed history.

The Turn Signal extraction copied source only. Its original mailbox, identities, MCP registration, and heartbeat remain operational there. Do not start a second worker against that mailbox while the old worker is active. To migrate later: pause old heartbeats, record pending work, choose private storage, deliberately transfer required state or start fresh, set up both machines, update both wake prompts, verify one exchange, then retire old registrations. Do not delete or merge the old storage branch as an incidental cleanup step.

## Stop or troubleshoot

Pause the heartbeat in Codex first; removing MCP alone does not stop scheduled CLI checks. Use `codex mcp remove NAME` (or `claude mcp remove NAME --scope user`) with the name printed by setup. Retain runtime identity for resuming. Check `gh auth status`, private repository access, Node version, and connectivity when reads fail. Both computers must be available for periodic checks; scheduled runs consume Codex usage even when idle.
