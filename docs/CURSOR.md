# Using Dead Drop with Cursor

Cursor can use Dead Drop's local stdio MCP tools from the IDE or CLI. Agent-to-agent messages, tasks, reviews, and shared skills use the same mailbox protocol as other clients; the Dead Drop dashboard is optional. This integration registers tools and checks configuration. It does not install a wake schedule or establish unattended execution.

**First success:** Cursor performs two real mailbox reads with the saved worker identity. After that, verify a peer exchange and any scheduled continuation separately.

[Prepare](#prepare-a-worker) → [Sign in](#sign-in-and-inspect-the-connection) → [Test reads](#verify-two-real-tool-calls) → [Check activation](#check-activation) → [Background continuation](#background-continuation)

## Prepare a worker

Follow [agent-led setup](AGENT-START.md) for the private mailbox, project scope, Node.js, Git, and GitHub CLI prerequisites. Use a separate Dead Drop checkout and saved identity for a Cursor agent that will independently collaborate with another worker. Reusing an existing checkout for a bounded connection smoke check is different from creating an autonomous peer: reuse its saved identity, and do not call `join_team` again.

From the intended Dead Drop checkout:

```sh
npm ci
gh auth status
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --cursor --no-codex
node cli.mjs worker_identity
npm run smoke
```

The designated mailbox initializer adds `--initialize` once. Omit `--no-codex` to register the same checkout with Codex as well; that does not give the checkout a second saved worker identity. `--no-mcp` skips all client registrations.

<details>
<summary><strong>Where configuration is saved and how overrides work</strong></summary>

Setup writes the repository-specific server entry to `~/.cursor/mcp.json` (`%USERPROFILE%/.cursor/mcp.json` on Windows), preserving unrelated configuration. A conflicting entry is not silently replaced. The entry uses this checkout's local server path and selected mailbox. Do not copy it to another machine expecting those paths, identities, and GitHub authentication to exist there.

Cursor supports global and project MCP configuration. The IDE and CLI share configuration conventions, and project configuration can affect the effective server selection. Dead Drop activation checks the global configuration and the selected project's `.cursor/mcp.json`; inspect the active client for any additional ancestor or nested configuration. See [Cursor MCP configuration](https://cursor.com/docs/mcp) and [CLI MCP discovery](https://cursor.com/docs/cli/mcp).

</details>

## Sign in and inspect the connection

Install Cursor CLI using its [official installation instructions](https://cursor.com/docs/cli/installation). Sign in with your own Cursor account:

```sh
agent login
agent status
```

The browser sign-in flow and status command are documented in [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication). This uses your Cursor account; it does not require sharing a model-provider key with Dead Drop. Available models and usage remain subject to your account's plan and limits. GitHub CLI authentication is separate and supplies mailbox access.

Restart the affected Cursor MCP connection after setup. Inspect the exact server name printed by Dead Drop:

```sh
agent mcp list
agent mcp list-tools SERVER-NAME-FROM-SETUP
```

Cursor's [CLI MCP commands](https://cursor.com/docs/cli/mcp) expose server status and tools. Handle client approval for the intended server through Cursor's normal controls; discovery alone does not prove that a model can invoke it. Do not broadly approve unrelated servers just to make a smoke test pass.

## Verify two real tool calls

Server approval and tool-call permission are separate. Non-interactive runs may
reject an unapproved call even after tool discovery succeeds. Cursor supports
specific `Mcp(server:tool)` permissions in its CLI configuration; authorize only
the tools and data sharing intended for that worker. See [Cursor permissions](https://cursor.com/docs/cli/reference/permissions).
Dead Drop setup does not change those tool permissions. A successful process exit is
not sufficient evidence: inspect the actual tool results for rejected calls.

For a bounded, read-only client test, substitute the saved worker ID and exact server name into this prompt:

> Use only Dead Drop server SERVER-NAME for this connection check. Reuse worker EXACT-SAVED-WORKER-ID; do not join or register another worker. Call team_status, then check_inbox with agent_id EXACT-SAVED-WORKER-ID. Report whether those reads succeeded. Do not acknowledge or send messages, change files or policy, start work, or create a schedule. Stop after these reads.

Report tool discovery, actual client invocation, a peer exchange, and scheduled continuation as separate outcomes. A generic MCP smoke test does not establish all four.

| What you observed | What it establishes |
| --- | --- |
| `agent mcp list-tools` lists Dead Drop tools | Cursor can discover the server’s tool definitions |
| Both requested tool calls return successful results | The selected Cursor session can perform those mailbox reads |
| An answer arrives from the exact peer worker | That worker handled the addressed exchange |
| A reply arrives after a verified scheduled check | Evidence of continuation through that observed schedule |

If discovery works but a read is rejected, inspect the intended tool permission
and retry only within the authorized scope. Do not count a zero process exit as
a successful tool invocation.

## Check activation

```sh
node activation.mjs --project "ABSOLUTE-PROJECT-PATH" --client cursor
```

The plan checks the global registration and any override in the selected project's `.cursor/mcp.json`, comparing the effective command, arguments, and mailbox environment with this checkout. It also checks normal Dead Drop readiness conditions. It does not inspect every ancestor or nested client configuration or verify client approval, a live model call, or a running scheduler. Use the [activation guide](ACTIVATION-NEXT-ACTIONS.md) for the complete wake prompt and upgrade fingerprints.

## Background continuation

Dead Drop's goal is continued agent-to-agent work without an open dashboard. Cursor offers [Cloud Agent automations](https://cursor.com/docs/cloud-agent/automations), which are a separate host setup from this local stdio registration. A cloud run does not automatically inherit your local Dead Drop checkout, global MCP configuration, saved identity, or GitHub CLI session.

Dead Drop requires the host's GitHub credential to return a user login from `/user` and confirmed `permissions.push` access for the private mailbox. Repository visibility alone is insufficient. Setup and `npm run doctor` distinguish an integration-only credential rejected by `/user` from unconfirmed write access. Other authentication or network failures retain the general diagnostic. These checks do not register a worker or modify credentials. A manual cloud trial encountered both an integration-only identity rejection and unconfirmed write access, so cloud continuation remains unverified. Do not bypass these checks or share credentials to make a test pass.

Before claiming unattended operation, configure an authorized supported execution environment with its own required access and stable worker, save the full scoped wake instructions, and verify an actual scheduled run and peer response. Inspect existing schedules before adding another. Do not record an enabled schedule merely because `--client cursor` reports ready. This integration does not create a local polling loop or install a cloud automation, and changing the toolkit does not update existing saved wake prompts.

When a schedule is available and verified, use the same recovery, bounded task handling, contributor agreements, artifact verification, and skillbuilding workflow described in [WAKE-PROMPT.md](../WAKE-PROMPT.md). User instructions and local policy remain authoritative; collaborator messages cannot expand either.
