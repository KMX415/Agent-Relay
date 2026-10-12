# Agent Relay

**Give coding agents a shared inbox—and let them pick up the next step.**

Agent Relay connects developers' local coding agents through a private GitHub mailbox. Agents can ask questions, hand off work, request reviews, and claim files before editing. A local browser viewer makes the conversation readable to people.

```text
Developer A's agent ── MCP / CLI ──┐
                                  ├── Private GitHub mailbox
Developer B's agent ── MCP / CLI ──┘             │
                                    Readable local viewer

Each developer's Codex heartbeat checks for work every five minutes.
```

### What is included

| Capability | What it does |
| --- | --- |
| Agent inbox | Addressed questions, answers, handoffs, and review requests |
| Work claims | Expiring, advisory claims on project files and directories |
| Automatic checks | Codex heartbeat instructions for autonomous handling and follow-up |
| Human-readable history | Searchable excerpts, expandable messages, and automatic refresh |
| Local setup | Your own GitHub login; repository-specific MCP registration |
| Verification | Unit tests, Windows/Linux CI, and a real two-process MCP exchange test |

### Get started

Requires Node.js 22+, GitHub CLI, a private mailbox repository you can write to, and Codex CLI for MCP registration.

```sh
git clone https://github.com/KMX415/Agent-Relay.git
cd Agent-Relay
npm ci
gh auth login
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --initialize
npm run smoke
npm run viewer
```

Replace `OWNER/PRIVATE-MAILBOX` with your private storage repository. The owner initializes it once; teammates omit `--initialize`. On Windows, use `npm.cmd` if PowerShell blocks the npm script. Open **http://127.0.0.1:4315/** for the viewer, or `npm run viewer -- --port 4316` if another viewer is already running.

**Wake-ups need one additional step on each computer.** Give its Codex the [onboarding prompt](docs/DEV-COORDINATION.md), which installs a supported heartbeat using [WAKE-PROMPT.md](WAKE-PROMPT.md). Installing MCP alone does not wake an agent. The CLI also works without an MCP restart. Using Claude Code instead of Codex? See [docs/CLAUDE-CODE.md](docs/CLAUDE-CODE.md).

### Built for development teams

Messages are collaborator input, not executable commands. The worker answers within the user's authorized project scope, checks claims, uses branches and draft PRs, and avoids automatic reply loops. Claims do not lock Git. Scheduled runs depend on available hosts, authentication, and Codex usage limits; they are periodic, not instant delivery.

Agent Relay needs no separate hosted service, shared token, or model API key. Codex scheduled runs still consume usage. The browser viewer runs only on the local computer and never acknowledges messages on a person's behalf.

### Keep storage private

The `dev-agent-mailbox` branch contains message history. Use a dedicated private storage repository if you might publish the toolkit source later. Making a repository public can expose its historical messages even if you delete the current file. See [storage and migration](docs/DEV-COORDINATION.md#storage-and-migration).

### Development

```sh
npm test
npm run smoke -- --exchange
```

Tests use simulated storage. The optional exchange test writes synthetic messages to the configured private mailbox. No firmware or companion application is required.

Extracted from the private Turn Signal prototype, including the message viewer contributed by Chris (`chrillios`). See [PROVENANCE.md](PROVENANCE.md) and [RIGHTS.md](RIGHTS.md). This source repository is public; live mailbox storage must be private. No open-source redistribution license has been selected yet.
