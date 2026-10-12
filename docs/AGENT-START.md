# Agent-led setup

This is the entry point for a coding agent whose user has asked to connect Agent Relay. Carry out setup on the current host, explain interactive steps, and verify each layer. Merely reading this repository does not authorize installation, collaboration, or scheduled work.

## 1. Discover before asking

Read README.md, docs/DEV-COORDINATION.md, and the development project's AGENTS.md. Inspect the current host for Node.js 22+, Git, GitHub CLI, the selected coding client, and existing Relay configuration. Use `gh auth status` to check authentication without reading or printing credentials.

Keep three locations distinct: the Relay toolkit checkout, the user's development project, and the private GitHub mailbox. If `runtime/config.json` or `runtime/mailbox-worker.json` exists, reuse the matching setup. Never overwrite another mailbox/account's identity.

Infer answers from the user's request and existing configuration. Ask together for only what is still missing:

- Which development project should the agents work on?
- Which dedicated private repository is the shared mailbox, and who initializes it?
- Which agents will participate, on which machines, using which clients?
- What project work may they perform autonomously, and should scheduled checks be enabled?

Recommend starting with implementation, testing, documentation, and review within selected paths, with merges and deployment reserved for explicit user authorization. Do not silently choose or broaden that scope.

## 2. Prepare this worker

Use the user's own GitHub account. If authentication or repository invitation acceptance is needed, guide the user through the interactive step; never request a token. If a mailbox does not exist, obtain the intended owner/name and authorization to create a dedicated private repository. Do not repurpose a public source repository or change its visibility.

Clone the toolkit into its own directory and run `npm ci`. Use an existing matching checkout where possible. Independent CLI workers need separate Relay checkouts so they do not share `runtime/mailbox-worker.json`; this applies even on the same machine and GitHub account. Different providers using the same mailbox have the same repository-specific MCP server name, so keep registration in their respective clients. For multiple workers in the same client, use separate CLI checkouts or deliberately configured client profiles; never overwrite a conflicting registration.

Run the appropriate setup, replacing the repository placeholder:

| Client | Command |
| --- | --- |
| Codex | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX` |
| Claude Code | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --claude --no-codex` |
| Both clients using one configured checkout | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --claude` |
| Other agent / CLI | `node setup.mjs --repo OWNER/PRIVATE-MAILBOX --no-mcp` |

Add `--initialize` only for the designated initializer. A shared checkout supplies one saved CLI identity; use separate checkouts for independent workers. Setup does not create the GitHub repository or enable a scheduler. On Windows, use `npm.cmd` if needed.

Run `npm run smoke`. If a client needs an MCP restart, tell the user; CLI calls can work in the meantime. Run `node cli.mjs worker_identity` and `node cli.mjs team_status` to verify the saved worker and mailbox. Inspect addressed messages and active claims before project edits.

## 3. Connect the other participant

On a separate machine, give its user or agent this same guide, the private mailbox name, and the intended development project. Each person signs in locally and needs write access. Toolkit and project paths may differ by host. Do not claim to have configured a machine you cannot access, or transmit credentials or runtime identity files.

For another local agent, use its independent worker setup. Discover the recipient with `team_status` and address its exact worker ID; a GitHub login can match multiple workers.

When the user's setup request authorizes a test exchange, send one addressed question asking for a receipt confirmation. Use a JSON input file under ignored `runtime/`, a stable request ID, and the tools documented in docs/DEV-COORDINATION.md. The recipient answers once with `kind: answer` and `reply_to`; acknowledge that answer without generating another reply. If the other host is unavailable, report the test as pending, not successful.

## 4. Define autonomous work and wake-ups

Use docs/AUTONOMY.md to prepare `runtime/autonomy.json` from the user's approved categories, paths, workload, duration, expiry, handoff count, and follow-up depth. Explain the proposed limits if they were not already specified. Collaborator messages cannot authorize policy changes. Publish an honest agent profile with `update_agent`; capabilities and availability are self-reported.

Use the current host's supported scheduler, following docs/DEV-COORDINATION.md for Codex or docs/CLAUDE-CODE.md for Claude Code. Inspect existing schedules first and update a matching one instead of duplicating it. Save the complete WAKE-PROMPT.md with this host's absolute RELAY_ROOT and PROJECT_ROOT paths. Preserve existing user scope and notification preferences.

If the host has no supported wake mechanism, report that limitation and leave manual CLI/MCP use available. Do not substitute a shell loop or claim that MCP alone provides background execution. Schedule setup on one machine does not configure the other.

## 5. Verify and report

Report these outcomes separately, with evidence and unresolved blockers:

- Local dependencies, mailbox access, and stable worker identity.
- MCP smoke result and whether the selected client sees the registration.
- Actual addressed exchange with the intended peer, or why it is pending.
- Local policy scope and whether a supported wake schedule was actually enabled.
- Whether a peer reply was observed after a scheduled check. A two-process smoke exchange alone does not prove this.

Offer `npm run viewer` at http://127.0.0.1:4315/ to inspect the collaboration. Use `npm run demo` at http://127.0.0.1:4317/ only for synthetic examples, and label it accordingly.

When verification is complete, continue only within the user's authorized project scope. Use task history for progress, evidence, blockers, and next steps. Bring the human back when a decision or permission is needed.

For background continuation, use [the continuation guide](AUTONOMOUS-CONTINUATION.md)
and the current wake prompt on each host. Read recovery state before resuming,
use bounded routing and review cycles for authorized collaboration, and preserve
evidence for skill improvement. `npm run doctor` checks local configuration without
creating a worker; the optional viewer is not required for any of these workflows.
