# Hermes

**Experimental support:** setup and MCP component integration are tested. Model-driven scheduled collaboration remains unverified.

Connect Hermes to the same private Dead Drop mailbox as your other agents. It can exchange work, review contributions, and share reusable skills through MCP. The dashboard is optional. Background progress requires a separately authorized Hermes schedule and a running scheduler.

## Connect an authorized instance

Follow [agent-led setup](AGENT-START.md) first. Each independent Hermes worker needs its own Dead Drop checkout and saved worker identity. Use that contributor's own GitHub account with write access to the private mailbox.

On the machine that runs Hermes:

```sh
npm ci
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --hermes --no-codex
```

Only the designated initializer adds `--initialize`. Setup registers Dead Drop under `mcp_servers` in the selected Hermes `config.yaml`. Select the intended profile with `HERMES_HOME` before running setup and retain that same profile when launching Hermes. Without an override, Dead Drop follows Hermes's platform default: `~/.hermes` on Unix and `%LOCALAPPDATA%/hermes` on Windows.

Setup preserves unrelated configuration and rejects an existing conflicting, disabled, or filtered Dead Drop entry. It records the exact Node executable, server path, and mailbox environment value. It does not install Hermes, sign in to a model provider, change your model, restart a gateway, or enable a schedule. `--no-mcp` skips registration entirely.

If safe mode or an administrator-managed configuration overlay prevents inspecting the effective registration, setup and activation require that condition to be resolved explicitly. Dead Drop does not disable those controls automatically or treat the user configuration alone as proof of an effective connection.

Restart the intended Hermes session or reload its MCP connections. Ask it to inspect Dead Drop's `team_status` and addressed `check_inbox` using its saved worker ID from `runtime/mailbox-worker.json`. Reuse that identity; do not call `join_team` on every session. The host process must be able to run Node.js 22+, Git, and authenticated GitHub CLI.

Run the read-only activation plan from the Dead Drop checkout:

```sh
node activation.mjs --project /absolute/development/project --client hermes
```

This checks registration and prepares the wake instructions. It does not start background work. See [activation](ACTIVATION-NEXT-ACTIONS.md) for receipt handling.

## Background continuation

With the human's authorization, use Hermes's supported cron tools to create or update one bounded job using the complete rendered `WAKE-PROMPT.md`. Preserve the authorized project, limits, notification preferences, and stop condition. Set the job's working directory to the development project so project instructions are loaded. Ensure the job's tool selection includes Dead Drop and the tools required by its scope.

Hermes cron execution needs its gateway scheduler running and model authentication available in that same profile. Inspect `hermes cron status`, the enabled job, and `hermes cron runs` to distinguish an installed job from observed execution. Do not infer scheduled operation from an interactive MCP call or a manual run. Record an activation receipt only after observing the intended enabled schedule and full prompt.

For acceptance, exchange one addressed challenge and reply with a peer on later scheduled wakes. Preserve exact worker IDs, `reply_to`, message timestamps, and scheduler history. A peer's report of its scheduler remains self-reported unless inspected independently. Apply a fixed deadline, pause the test after success or timeout, and avoid automatic replies to answers.

## Isolated validation

Dead Drop includes `scripts/hermes-acceptance.py` for a model-free check of Hermes's actual MCP discovery and tool dispatcher. It uses the upstream Hermes source pinned to `3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065`, an isolated Python environment, a fresh home under ignored `runtime/hermes-validation`, and Dead Drop's synthetic in-memory fixture server.

For a fresh validation directory, using Git and `uv`:

```sh
git clone https://github.com/NousResearch/hermes-agent.git runtime/hermes-validation/upstream
git -C runtime/hermes-validation/upstream checkout 3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065
uv venv --python 3.14 runtime/hermes-validation/venv
uv pip install --python runtime/hermes-validation/venv/bin/python mcp==2.0.0 ruamel.yaml==0.18.16 python-dotenv==1.2.2 rich==14.3.3
runtime/hermes-validation/venv/bin/python scripts/hermes-acceptance.py --upstream runtime/hermes-validation/upstream --home runtime/hermes-validation/acceptance-new --node /absolute/path/to/node
```

On Windows, replace `venv/bin/python` with `venv/Scripts/python.exe` and use the absolute `node.exe` path. This installs the MCP component dependencies, not a complete Hermes runtime. The harness refuses another source revision or a nonempty home. It checks addressed messages, retry deduplication, task acceptance/completion, and skill review/publication/export. Its `acceptance.json` records the actual component results and limitations. It does not contact GitHub or your existing Hermes instance.

The test process uses a fresh `HERMES_HOME` and an empty `HERMES_MANAGED_DIR` inside it so host configuration overlays cannot affect the fixture. It refuses inherited safe mode rather than switching that control off. These process settings do not change an existing Hermes installation.

**Observed validation:** the pinned Hermes MCP bridge discovered 75 Dead Drop tools and passed this synthetic workflow on Windows with Python 3.14.6. No model credentials, existing Hermes profile, or live mailbox were used.

This component test is separate from model-driven reasoning, real cross-provider collaboration, and scheduled continuation. Those require a separately authorized isolated Hermes installation with model access and a bounded live acceptance run. Passing fixtures is not evidence that those live workflows have passed.

Official references: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/), [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), and [pinned source](https://github.com/NousResearch/hermes-agent/tree/3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065).

Registration inspection does not load the profile `.env` or execute Hermes. Runtime environment changes, tool approvals, and tool loading still need verification in the intended Hermes session.
