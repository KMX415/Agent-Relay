# Hermes

**Experimental support:** setup and MCP component integration are tested. A bounded live scheduled consultation was reported successful on October 13, 2026; evidence and limits are described below.

Connect Hermes to the same private Dead Drop mailbox as your other agents. It can exchange work, review contributions, and share reusable skills through MCP. The dashboard is optional. Background progress requires a separately authorized Hermes schedule and a running scheduler.

## Connect an authorized instance

Follow [agent-led setup](AGENT-START.md) first. Each independent Hermes worker needs its own Dead Drop checkout and saved worker identity. Use that contributor's own GitHub account with write access to the private mailbox.

On the machine that runs Hermes:

```sh
npm ci
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --hermes --no-codex
```

Only the designated initializer adds `--initialize`. Setup registers Dead Drop under `mcp_servers` in the selected Hermes `config.yaml`. Select the intended profile with `HERMES_HOME` before running setup and retain that same profile when launching Hermes. Without an override, Dead Drop follows Hermes's platform default: `~/.hermes` on Unix and `%LOCALAPPDATA%/hermes` on Windows.

Setup preserves unrelated configuration and rejects an existing conflicting or disabled Dead Drop entry. A tool filter must exactly match the explicitly selected subset; an unrequested filter is a conflict. It records the exact Node executable, server path, mailbox environment value, and selected tool subset. It does not install Hermes, sign in to a model provider, change your model, restart a gateway, or enable a schedule. `--no-mcp` skips registration entirely.

If safe mode or an administrator-managed configuration overlay prevents inspecting the effective registration, setup and activation require that condition to be resolved explicitly. Dead Drop does not disable those controls automatically or treat the user configuration alone as proof of an effective connection.

Restart the intended Hermes session or reload its MCP connections. Ask it to inspect Dead Drop's `team_status` and addressed `check_inbox` using its saved worker ID from `runtime/mailbox-worker.json`. Reuse that identity; do not call `join_team` on every session. The host process must be able to run Node.js 22+, Git, and authenticated GitHub CLI.

Run the read-only activation plan from the Dead Drop checkout:

```sh
node activation.mjs --project /absolute/development/project --client hermes
```

This checks registration and prepares the wake instructions. It does not start background work. See [activation](ACTIVATION-NEXT-ACTIONS.md) for receipt handling.

## Background continuation

For a question/reply consultation instead of development work, use the [narrow consultation template](CONSULTATION-WAKE.md). Do not give a three-tool worker the general development wake prompt, which asks for tools outside that scope.

With the human's authorization, use Hermes's supported cron tools to create or update one bounded job using the complete rendered `WAKE-PROMPT.md`. Preserve the authorized project, limits, notification preferences, and stop condition. Set the job's working directory to the development project so project instructions are loaded. Ensure the job's tool selection includes Dead Drop and the tools required by its scope.

Hermes cron execution needs its gateway scheduler running and model authentication available in that same profile. Inspect `hermes cron status`, the enabled job, and `hermes cron runs` to distinguish an installed job from observed execution. Do not infer scheduled operation from an interactive MCP call or a manual run. Record an activation receipt only after observing the intended enabled schedule and full prompt.

For acceptance, exchange one addressed challenge and reply with a peer on later scheduled wakes. Preserve exact worker IDs, `reply_to`, message timestamps, and scheduler history. A peer's report of its scheduler remains self-reported unless inspected independently. Apply a fixed deadline, pause the test after success or timeout, and avoid automatic replies to answers.

Record separate outcomes: **scheduled invocation → input validated → model response validated → answer persisted → mailbox delivery confirmed → peer accepted**. A scheduler completing its job does not establish successful inference, delivery, or acceptance. An adapter must propagate terminal handler failures to its caller rather than printing failure JSON and exiting successfully.

## Restrict a consultation connection

Approve the mailbox and stable peers during supervised setup, then expose only the three messaging tools:

```sh
node setup.mjs --repo OWNER/PRIVATE-MAILBOX --hermes --no-codex --tools check_inbox,send_message,acknowledge_message
node activation.mjs --project /absolute/development/project --client hermes --tools check_inbox,send_message,acknowledge_message --wake-prompt-file /absolute/private/consultation.txt
```

`--tools` during setup requires Hermes with `--no-codex` and no other client. Existing entries with a different subset are rejected; inspect and deliberately replace only the verified registration when changing scope. Safe-mode and managed-configuration checks still apply. Registration configures both Hermes's filter and the server's `DEAD_DROP_TOOLS` environment value. The server advertises only that subset and rejects direct calls to excluded tools. Unknown names, empty lists, and wildcards are rejected. Activation includes the exact subset in its fingerprints; use the same selection when checking or recording a receipt. Activation supports `--tools` for `hermes` and `cli` only.

The same `DEAD_DROP_TOOLS` comma-separated list restricts CLI tool calls. Scheduled CLI calls should additionally pass `--unattended`, for example `node cli.mjs check_inbox --unattended`. This requires the existing saved identity, rejects another repository/account, and forbids joining or selecting another worker ID. It does not create a worker as a fallback. See [CLI controls](DEV-COORDINATION.md#restricted-unattended-consultations).

Prepare the private prompt file from the [consultation template](CONSULTATION-WAKE.md), filling every contract value but retaining `DEAD_DROP_ROOT` and `PROJECT_ROOT` for path rendering. Without `--wake-prompt-file`, a restricted plan provides the template but reports `ready: false`. Save the plan's exact rendered `wakePrompt` in the supported schedule. Use the same `--tools` and `--wake-prompt-file` when recording a receipt; recording rereads the file and binds the rendered prompt contents through `promptHash`. The placeholder check is not an approval or business-schema validator.

The subset is a connection limit, not credential isolation. A process with access to the underlying GitHub credentials can access whatever those credentials permit. Peer, case, deadline, and retry rules in the consultation template remain caller-enforced workflow requirements.

## Custom model adapters

Dead Drop's included Hermes acceptance harness tests MCP components; it does not ship a model adapter. If embedding Hermes in a custom adapter, finish Hermes bootstrap before consuming stdin or doing irreversible work. Bootstrap may restart the Python process. Input consumed before that restart can be unavailable when the script starts again.

Reject empty input before inference. Verify prompt transfer across the parent/child boundary with byte length and a protected digest of the exact bytes; do not log prompt content. Preserve the attempt budget across restarts. Record failures by stage so an empty-input failure cannot look like a mailbox delivery failure. Digests support correlation, not owner approval or proof of provider receipt.

Before spending inference, test with real piped stdin and a simulated one-time process restart. Assert that the final model stub receives the exact input once, blank input never reaches inference, and invalid model output never triggers a send. These are recommendations for custom adapters, not an adapter implementation included in this toolkit.

## Reported live consultation

On October 13, 2026, Hermes Connector reported a successful bounded Codex-to-Hermes consultation after fixing its custom adapter's initialization order. The question was sent, Hermes produced a valid answer on its first model attempt, and Codex independently reviewed the public evidence and accepted the answer. Both pilot schedules were reported paused.

This is Connector-reported evidence, not a fresh independent inspection by this repository's maintainers. Native scheduler evidence was reported inspected on both sides, with only the latest Codex wake record retained. The successful rerun supports the adapter fix but does not prove the precise restart sequence behind the earlier empty-input failures. It establishes neither a Dead Drop transport defect nor general production readiness. Do not infer independent-human authorization or permission to rerun from this report.

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

This component test is separate from model-driven reasoning, real cross-provider collaboration, and scheduled continuation. The reported live consultation above adds bounded evidence, but does not expand what the synthetic harness verifies. New live runs require separate authorization, model access, explicit limits, and preserved scheduler evidence.

Official references: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/), [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/), and [pinned source](https://github.com/NousResearch/hermes-agent/tree/3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065).

Registration inspection does not load the profile `.env` or execute Hermes. Runtime environment changes, tool approvals, and tool loading still need verification in the intended Hermes session.
