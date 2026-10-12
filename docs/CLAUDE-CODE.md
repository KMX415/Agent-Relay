# Using Agent Relay with Claude Code

Agent Relay's storage, CLI and viewer are agent-neutral. Only two things in the
default setup are Codex-specific: MCP registration (`codex mcp add`) and the
wake-up heartbeat (a Codex automation). This page covers the Claude Code
equivalents. Everything else in [DEV-COORDINATION.md](DEV-COORDINATION.md)
applies unchanged.

## 1. Setup

```sh
git clone https://github.com/KMX415/Agent-Relay.git RELAY_ROOT
cd RELAY_ROOT
npm ci
gh auth login
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --no-mcp          # teammates
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --no-mcp --initialize   # owner, once
```

`--no-mcp` skips Codex registration and still saves `runtime/config.json` and
the stable worker identity in `runtime/mailbox-worker.json`. Use one Agent
Relay clone per agent (see below).

## 2. Talk to the mailbox: use the CLI

The CLI works from a Claude Code session with no registration and no restart.
Run it from `RELAY_ROOT`:

```sh
node cli.mjs team_status
node cli.mjs check_inbox
node cli.mjs send_message --input runtime/message.json
node cli.mjs acknowledge_message --input runtime/ack.json
```

Put arguments in a JSON file under `runtime/` and pass it with `--input`;
never paste message text into a shell command. For example, `runtime/ack.json`
is just `{"message_id":"ID-FROM-CHECK-INBOX"}`; the CLI adds your saved
worker ID itself.

**Optional: register the MCP server with Claude Code.** The server is a plain
stdio MCP server, so the usual Claude Code form should work:

```sh
claude mcp add agent-relay --env AGENT_MAILBOX_REPO=OWNER/PRIVATE-MAILBOX -- node /absolute/path/to/RELAY_ROOT/server.mjs
```

Restart the Claude Code session afterwards. The CLI route above is the one
this page recommends, because it needs nothing else.

## 3. Wake-ups: `/loop` instead of a Codex heartbeat

Claude Code has no Codex automations, so `WAKE-PROMPT.md` is run on a timer
inside an open Claude Code session with the built-in `/loop` command:

1. Copy the text of [WAKE-PROMPT.md](../WAKE-PROMPT.md).
2. Replace `RELAY_ROOT` and `PROJECT_ROOT` with absolute paths.
3. In the session where work should continue, run:

   ```
   /loop 10m <the wake prompt text>
   ```

   Ten minutes is a good default; use 5 if you want the heartbeat cadence the
   Codex setup uses.

Things to know:

- The loop runs **only while that session is open.** Closing it stops the
  wake-ups; the next session should start by running `check_inbox`.
- Each computer and each session sets up its own loop. Cloning the repo does
  not enable one.
- Scheduled runs consume Claude Code usage, even when idle.

## 4. Project instructions: CLAUDE.md

Codex reads `AGENTS.md`; Claude Code reads `CLAUDE.md`. In the *development
project* (not the Agent Relay clone), keep one source of truth by importing
the existing file from `CLAUDE.md`:

```markdown
@AGENTS.md
```

## 5. Onboarding prompt for Claude Code

Give this to Claude Code in the session where development should continue,
after replacing the three placeholders:

> Set up Agent Relay from RELAY_ROOT for development in PROJECT_ROOT, using
> private mailbox OWNER/PRIVATE-MAILBOX and my own GitHub account. Follow
> Agent Relay's docs/DEV-COORDINATION.md and docs/CLAUDE-CODE.md. Install
> dependencies and run `node setup.mjs --no-mcp`, initialize storage only if I
> am its designated owner, and verify `node cli.mjs team_status` works. Then
> start a `/loop` on this session using the complete WAKE-PROMPT.md
> instructions, with RELAY_ROOT and PROJECT_ROOT replaced by absolute paths.
> This authorizes project-scoped agent messages, handling development
> handoffs, relevant tests, feature branches and draft PRs; it does not
> authorize main merges, deployments or unrelated work. Report whether the
> loop was actually started. Interactive authentication stays with me; do not
> request my token.

## 6. Several agents on one GitHub account

If more than one agent shares the same GitHub login (for example two Claude
Code sessions on one machine), note that:

- Setup labels every worker `<login> development worker`. Send an `update`
  early saying which agent you are, so people reading `team_status` can tell
  them apart.
- A message addressed to a login reaches **every** worker under it. Address an
  exact worker ID (from `team_status`) when you mean one agent.
- Use a separate Agent Relay clone per agent so each keeps its own stable
  identity and pending work.
