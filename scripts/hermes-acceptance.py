"""Exercise the actual Hermes MCP bridge with an isolated synthetic Relay server.

No model, GitHub account, gateway, or existing Hermes profile is used.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

PIN = "3b63f7b0a4c7beb9eadbce2f15b9da75d01f5065"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--node", required=True)
    args = parser.parse_args()
    if os.environ.get("HERMES_SAFE_MODE", "").strip().lower() in {"1", "true", "yes", "on"}:
        parser.error("Hermes safe mode is enabled; run this isolated test from an explicitly approved test environment instead of disabling host controls")
    root = Path(__file__).resolve().parents[1]
    home = args.home.resolve()
    runtime = (root / "runtime" / "hermes-validation").resolve()
    if not home.is_relative_to(runtime) or home == runtime:
        parser.error("--home must be a fresh child of runtime/hermes-validation")
    if home.exists() and any(home.iterdir()):
        parser.error("--home must be empty; existing Hermes profiles are never reused")
    upstream = args.upstream.resolve()
    commit = subprocess.check_output(
        ["git", "-c", f"safe.directory={upstream.as_posix()}", "-C", str(upstream), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    if commit != PIN:
        parser.error(f"Expected pinned Hermes source {PIN}, found {commit}")
    if subprocess.call(["git", "-c", f"safe.directory={upstream.as_posix()}", "-C", str(upstream), "diff", "--quiet", "HEAD"]) != 0:
        parser.error("Pinned Hermes source contains tracked modifications")
    home.mkdir(parents=True, exist_ok=True)
    # Isolation is set before importing any upstream module. The fixture has no
    # credentials or network transport and its synthetic state exists in memory.
    os.environ["HERMES_HOME"] = str(home)
    # The upstream loader also reads an administrator overlay independently of
    # HERMES_HOME. Point only this disposable process at its own empty overlay.
    managed = home / "managed"
    managed.mkdir()
    os.environ["HERMES_MANAGED_DIR"] = str(managed)
    # Do not inherit model/GitHub secrets for a credential-free component check.
    # Retain ordinary platform variables needed to launch Node and Python.
    for key in list(os.environ):
        upper = key.upper()
        if any(part in upper for part in ("TOKEN", "API_KEY", "SECRET", "PASSWORD", "CREDENTIAL")):
            os.environ.pop(key, None)
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    config = {"mcp_servers": {"relay-test": {
        "command": args.node,
        "args": [str(root / "test" / "fixtures" / "hermes-relay-server.mjs")],
        "cwd": str(root),
        "timeout": 30,
    }}}
    # JSON is a YAML subset, allowing a config with no serializer dependency here.
    (home / "config.yaml").write_text(json.dumps(config, indent=2), encoding="utf-8")
    sys.path.insert(0, str(upstream))
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    from tools.registry import registry

    transcript = []

    def call(tool_name, **payload):
        wrapped = registry.dispatch(mcp_prefixed_tool_name("relay-test", tool_name), payload)
        envelope = json.loads(wrapped) if isinstance(wrapped, str) else wrapped
        if "error" in envelope:
            raise RuntimeError(f"{tool_name}: {envelope['error']}")
        value = envelope.get("structuredContent", envelope.get("result", envelope))
        if isinstance(value, str):
            value = json.loads(value)
        transcript.append({"tool": tool_name, "arguments": payload, "result": value})
        return value

    try:
        names = discover_mcp_tools(allowed_mcp_names=["relay-test"])
        expected = ["join_team", "send_message", "check_inbox", "create_task", "create_skill", "review_skill"]
        for name in expected:
            assert mcp_prefixed_tool_name("relay-test", name) in names, name
        first = call("join_team", label="Synthetic Hermes worker", task="Isolated MCP acceptance")
        second = call("join_team", label="Synthetic peer", task="Isolated MCP acceptance")
        a, b = first["id"], second["id"]
        question = call("send_message", agent_id=a, to=b, kind="question", body="Synthetic relay challenge", request_id="hermes-question")
        retry = call("send_message", agent_id=a, to=b, kind="question", body="Synthetic relay challenge", request_id="hermes-question")
        assert retry["id"] == question["id"]
        inbox = call("check_inbox", agent_id=b)
        assert [m["id"] for m in inbox["messages"]] == [question["id"]]
        answer = call("send_message", agent_id=b, to=a, kind="answer", body="Synthetic relay answer", reply_to=question["id"], request_id="hermes-answer")
        received = call("check_inbox", agent_id=a)["messages"]
        assert len(received) == 1 and received[0]["replyTo"] == question["id"] and received[0]["from"] == b
        call("acknowledge_message", agent_id=b, message_id=question["id"])
        call("acknowledge_message", agent_id=a, message_id=answer["id"])
        assert not call("check_inbox", agent_id=a)["messages"]
        task = call("create_task", agent_id=a, assignee_id=b, title="Synthetic coordination check", description="No production code or external effects.", acceptance=["Record synthetic fixture evidence"], request_id="hermes-task")
        task = call("update_task", agent_id=b, task_id=task["id"], expected_revision=task["revision"], action="accept", summary="Accept fixture-only task", request_id="hermes-task-accept")
        task = call("update_task", agent_id=b, task_id=task["id"], expected_revision=task["revision"], action="complete", summary="Synthetic evidence recorded", artifacts=["fixture://hermes-bridge"], request_id="hermes-task-complete")
        assert task["status"] == "completed"
        skill = call("create_skill", agent_id=b, name="synthetic-bridge-check", title="Synthetic bridge check", description="Fixture-only lesson", when_to_use="Only in this synthetic acceptance", steps=["Read the addressed challenge"], validation=["Assert matching reply_to and sender"], limitations=["No model or scheduler validation"], evidence=["fixture://hermes-bridge"], source_task_id=task["id"], request_id="hermes-skill")
        skill = call("review_skill", agent_id=a, skill_id=skill["id"], expected_revision=skill["revision"], verdict="approve", summary="Synthetic fixture checks passed", evidence=["fixture://hermes-bridge"], request_id="hermes-skill-review")
        skill = call("update_skill", agent_id=b, skill_id=skill["id"], expected_revision=skill["revision"], action="publish", summary="Publish inside isolated fixture only", request_id="hermes-skill-publish")
        assert skill["status"] == "published"
        exported = call("export_skill", agent_id=a, skill_id=skill["id"])
        assert exported["filename"] == "SKILL.md" and exported["sha256"]
        report = {"ok": True, "hermes_commit": commit, "python": sys.version.split()[0], "tools_discovered": len(names), "calls": transcript, "limitations": ["Direct Hermes MCP component calls, no model inference", "Synthetic workers and in-memory mailbox, no GitHub or independent humans", "No gateway or scheduled wake verified"]}
        (home / "acceptance.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key != "calls"}))
    finally:
        shutdown_mcp_servers()


if __name__ == "__main__":
    main()
