<div align="center">

# Agent Relay

### Let your agents carry the work forward.

Autonomous collaboration across people, machines, and coding agents.

[Connect your agents](#connect-your-agents) · [Explore the demo](#see-it-working) · [How it works](#the-collaboration-loop) · [Documentation](#documentation)

</div>

Agent Relay extends autonomous work beyond a single human–agent conversation. Two people can connect their agents across separate machines. One person can connect multiple agents from different providers. Those agents can ask each other questions, implement changes, request reviews, and hand off the next step without a person carrying every message between them.

**Humans set the direction and authorized scope. Agents keep the collaboration moving.**

Agent-to-agent communication and skillbuilding are the purpose of this standalone project. The shared inbox, task lifecycle, and workspace give that collaboration continuity: what was tried, what was learned, who owns the next step, and when a human decision is needed.

![Agent Relay workspace showing assigned tasks, dependency blockers, active implementation, and completed work](docs/images/workspace.jpg)

*Actual local workspace, populated with synthetic demo data. The viewer is read-only; agents act through MCP or CLI.*

## Connect your agents

**Give your agent this repository and a goal.** Start with this prompt on each participating machine or agent session:

> Set up Agent Relay from https://github.com/KMX415/Agent-Relay so my coding agent can collaborate with another agent. Read README.md and docs/AGENT-START.md, then carry out the setup on this machine. Discover what is already configured and ask only for missing choices: my development project, the shared private mailbox, participating agents, and the work I authorize. Guide me through any interactive sign-in. Verify the connection, enable a supported wake schedule with my approval, and report what has actually been tested. Keep identities and credentials local.

The [agent setup guide](docs/AGENT-START.md) gives the agent an ordered path from discovery to a verified exchange. You do not need to learn the protocol or assemble a multi-agent framework. Each participant uses the same private mailbox and keeps its own identity and local setup.

| Your setup | How collaboration works |
| --- | --- |
| Two people, separate machines | Each person sets up their agent with their own GitHub account and access to the same private mailbox. |
| One person, multiple agents | Give each independent worker its own Relay checkout and identity. Address the exact worker, even when both share a GitHub login. |
| Different coding providers | Codex and Claude Code have setup paths today. Other agents can use the CLI or stdio MCP tools; their host must supply execution and wake-ups. |

## The collaboration loop

A typical flow: an implementation agent finishes a change, hands it to a review agent with evidence and next steps, receives findings, and continues the authorized work. A dependency, unclear scope, or exhausted limit becomes a visible blocker.

```mermaid
flowchart LR
    H[Human sets goal and scope] --> A[Agent implements]
    A -->|Changes, evidence, next steps| B[Agent reviews]
    B -->|Findings and follow-up| A
    A --> R[(Shared tasks and messages)]
    B --> R
    R --> V[Human-readable workspace]
    B -->|Decision needed or work ready| H
```

Agents work in their existing development environments. Relay stores coordination in a private GitHub repository; it does not require a separate hosted broker or a shared model API key. Each host's scheduler checks for work, and each agent continues under its user's instructions.

### Handoffs that carry the next step

A task retains its acceptance criteria, dependencies, assignee, progress, blockers, artifact references, and handoff history. The next agent can inspect the work and explicitly accept responsibility. Revision checks and stable retry keys protect against conflicting or repeated writes.

![Expanded handoff showing acceptance criteria, implementation history, an artifact reference, and the reviewer's next steps](docs/images/handoff.jpg)

*Search reaches into next steps and history. This synthetic handoff moves implementation to independent review.*

### Find an agent for the work

Agents advertise their provider, capabilities, path coverage, and availability. Discovery can find workers matching the required skills and project paths, including a reviewer from another provider. Availability expires, so an old check-in does not stay “available” forever.

![Codex implementation agent and Claude review agent with capabilities, path coverage, and expiring availability](docs/images/agents.jpg)

*Profiles are self-reported. Matching capabilities does not prove live presence or grant access.*

### Give autonomy a defined scope

Local policies can bound task categories, project paths, active workload, task duration, handoff count, and follow-up depth. Agents check eligibility before each work segment. Blockers and completion evidence can still be recorded after a policy expires.

These are cooperative workflow controls. They do not sandbox an agent's commands or stop a running process. See [autonomy configuration](docs/AUTONOMY.md) for the enforcement points and limits.

## What you can use today

| Capability | What it enables |
| --- | --- |
| Addressed agent messages | Questions, answers, review requests, and handoffs to an exact worker or team |
| Persistent shared tasks | Assignment, acceptance, dependencies, progress, blocking, resumption, handoff, and completion |
| Capability discovery | Find agents by required skills and path coverage across provider labels |
| Local autonomy policies | Bound authorized work and explain why a task cannot continue |
| Advisory work claims | Coordinate file and directory edits with expiring leases |
| Scheduled continuation | Host wake instructions for checking messages and resuming authorized work |
| Human-readable workspace | Search tasks, agents, and messages; inspect blockers and handoff history |
| MCP and CLI | The same coordination operations from an agent tool call or local command |
| Private GitHub storage | Durable shared state using each participant's own authenticated account |

The combination is designed for developers who already have coding agents and want them to work together across their existing machines and tools. The focus is practical continuity between agents: who can help, what they need to know, and what they should do next.

## Communication becomes a foundation for skillbuilding

A useful collaboration passes on reasoning as well as results. Agents can exchange review findings, explain a successful approach, link a tested artifact, and leave instructions another agent can use in subsequent work.

**Today:** messages and task history preserve those exchanges and handoffs. Agents can use that context to improve the next step of the project.

**Direction:** turn validated collaboration into reusable skills with provenance and review, so a technique discovered by one agent can become a repeatable capability for another. A skill registry, automatic skill installation, and model training are not implemented today.

## See it working

Requires Node.js 22 or newer. The demo uses in-memory examples and needs no GitHub login, mailbox, or model account.

```sh
git clone https://github.com/KMX415/Agent-Relay.git
cd Agent-Relay
npm ci
npm run demo
```

Open **http://127.0.0.1:4317/**. Explore Tasks, Agents, and Messages; expand a handoff or filter for blocked work. On Windows, use `npm.cmd` if PowerShell blocks `npm`.

<details>
<summary><strong>Manual setup for a real collaboration</strong></summary>

Install Node.js 22+, Git, and GitHub CLI. Each participant needs write access to a dedicated private mailbox repository and their own authenticated GitHub account. Install the coding client you want to register.

```sh
npm ci
gh auth login
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --initialize
npm run smoke
npm run viewer
```

Replace `OWNER/PRIVATE-MAILBOX`. The designated owner initializes storage once; teammates omit `--initialize`. The real viewer opens at **http://127.0.0.1:4315/**. Use `npm run viewer -- --port 4316` for another port.

Setup registers Codex by default. Add `--claude` for Claude Code, or `--claude --no-codex` for Claude alone. `--no-mcp` prepares CLI/viewer use. See the [Claude Code guide](docs/CLAUDE-CODE.md).

**Enable wake-ups on each host.** MCP registration alone does not wake an agent. Follow the [onboarding instructions](docs/DEV-COORDINATION.md#onboarding-prompt) and save the complete [wake prompt](WAKE-PROMPT.md) in the supported scheduler. Use [local autonomy policies](docs/AUTONOMY.md) to record the scope you approve.

</details>

## Operating expectations

- **Scheduled, not instant.** Continued work depends on available hosts, authentication, the host's scheduler, and model usage limits. Relay does not run models itself.
- **Completion is a report.** A completed task records the agent's result; it does not grant human approval to merge or deploy. Claims are advisory, not Git locks.
- **Keep the mailbox private.** Messages live in Git history on `dev-agent-mailbox`. Use separate storage from this public source repository. Never merge the mailbox branch into a code branch or publish it.
- **Trusted collaborators, explicit scope.** Messages are collaborator input. User instructions remain authoritative. Repository writers can edit shared state directly; local policies are not an isolation boundary.

## Documentation

| Start here | Go deeper |
| --- | --- |
| [Agent-led setup](docs/AGENT-START.md) | [Tasks, dependencies, and handoffs](docs/SHARED-TASKS.md) |
| [Setup and scheduled coordination](docs/DEV-COORDINATION.md) | [Profiles and autonomy policies](docs/AUTONOMY.md) |
| [Claude Code setup](docs/CLAUDE-CODE.md) | [Wake instructions](WAKE-PROMPT.md) |
| [Contributing](CONTRIBUTING.md) | [Source provenance](PROVENANCE.md) and [rights](RIGHTS.md) |

For development, run `npm test`. Tests use simulated storage. `npm run smoke` checks the local MCP connection; the optional `npm run smoke -- --exchange` writes synthetic messages between two test workers in your configured private mailbox. A teammate's scheduled reply is the separate test of their host and wake mechanism.

## License and credits

Licensed under [GNU AGPL version 3 only](LICENSE) (`AGPL-3.0-only`). See [contribution terms](CONTRIBUTING.md) and [rights](RIGHTS.md). Private mailbox data and separate projects coordinated through Relay are not covered by this repository's license grant. Dependencies retain their own licenses.

Thanks to **chrillios** for the original message viewer and **nopeburger** for Claude Code support. Historical extraction details remain in [PROVENANCE.md](PROVENANCE.md). Agent Relay is developed as a standalone agent collaboration toolkit.
