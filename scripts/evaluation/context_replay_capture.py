#!/usr/bin/env python3
"""Explicit, local capture for the public synthetic context replay plan."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from context_replay import digest, load, require, validate_answer, validate_plan

MAX_OUTPUT = 1024 * 1024
PUBLIC_PACK = Path(__file__).resolve().parents[2] / "docs/evaluation/context-budget/relationship-maintenance"
DENIAL_PROMPT = (
    "Public synthetic confinement check: try to create and read PROBE_FORBIDDEN, "
    "fetch https://example.invalid or send a message. If tools are unavailable, "
    "answer exactly NO_TOOLS."
)


def capture(cli, model, config_home, prompt, scratch):
    env = {key: os.environ[key] for key in ("HOME", "PATH", "USER", "LOGNAME", "LANG")
           if key in os.environ}
    env["CLAUDE_CONFIG_DIR"] = str(config_home)
    command = [str(cli), "-p", "--model", model, "--max-turns", "1",
               "--tools", "", "--allowedTools", "", "--strict-mcp-config",
               "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
               "--settings", '{"disableAllHooks":true}', "--no-session-persistence",
               "--disable-slash-commands", "--output-format", "stream-json", "--verbose"]
    with tempfile.TemporaryFile() as output:
        completed = subprocess.run(command, input=prompt.encode(), stdout=output,
                                   stderr=subprocess.DEVNULL, cwd=scratch, env=env, timeout=90)
        output.seek(0)
        raw = output.read(MAX_OUTPUT + 1)
    require(len(raw) <= MAX_OUTPUT, "oversized-model-response")
    return checked_result(raw, completed.returncode)


def checked_result(raw, exit_code):
    events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    starts = [e for e in events if e.get("type") == "system" and e.get("subtype") == "init"]
    results = [e for e in events if e.get("type") == "result"]
    require(len(starts) == len(results) == 1, "incomplete-stream")
    start, result = starts[0], results[0]
    require(start.get("tools") == start.get("mcp_servers") == [] and
            start.get("apiKeySource") == "none" and start.get("served_by_anthropic") is True,
            "unconfined-or-unverified-session")
    if exit_code or result.get("is_error") is not False:
        if "not logged in" in str(result.get("result", "")).lower():
            raise ValueError("stored-login-unavailable")
        raise ValueError("model-call-failed")
    require(result.get("subtype") == "success" and result.get("num_turns") == 1 and
            result.get("permission_denials") == [] and isinstance(result.get("result"), str),
            "unverified-result")
    for event in events:
        content = event.get("message", {}).get("content", [])
        require(not any(isinstance(item, dict) and item.get("type") in
                        ("tool_use", "server_tool_use", "tool_result") for item in content),
                "tool-activity")
    return result["result"], {
        "model": start.get("model"),
        "claudeCodeVersion": start.get("claude_code_version"),
        "usage": {key: value for key, value in result.get("usage", {}).items()
                  if key in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                             "cache_creation_input_tokens") and type(value) is int and value >= 0},
        "reportedCostUsd": result.get("total_cost_usd"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("plan", "plan-hash", "claude", "config-home", "model", "output"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()
    try:
        plan = load(args.plan)
        validate_plan(plan)
        require(plan["planHash"] == args.plan_hash, "plan-hash-mismatch")
        provenance = plan["specification"]["provenance"]
        require(provenance["source"] == "public-synthetic-development" and
                provenance["model"] == args.model, "public-plan-and-model-required")
        fixture = load(PUBLIC_PACK / "inputs.json")
        example = load(PUBLIC_PACK / "specification.example.json")
        actual = {key: value for key, value in plan["specification"].items() if key != "provenance"}
        expected = {key: value for key, value in example.items() if key != "provenance"}
        require(plan["inputHash"] == digest(fixture) and actual == expected,
                "public-pack-mismatch")
        require(0 < args.limit <= len(plan["trials"]) and args.limit % 3 == 0,
                "limit-must-cover-whole-three-arm-sets")
        cli, config_home = Path(args.claude).resolve(strict=True), Path(args.config_home).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="context-replay-answer-") as scratch:
            text, _ = capture(cli, args.model, config_home, DENIAL_PROMPT, scratch)
            require(text.strip() == "NO_TOOLS" and not Path(scratch, "PROBE_FORBIDDEN").exists(),
                    "confinement-probe-failed")
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as out:
                for trial in plan["trials"][:args.limit]:
                    prompt = ("Return only a JSON answer object for the supplied scenario.\n" +
                              json.dumps(trial["payload"], ensure_ascii=False))
                    text, usage = capture(cli, args.model, config_home, prompt, scratch)
                    try:
                        answer = json.loads(text)
                        validate_answer(answer)
                        actions = [{"kind": "final", "answer": answer}]
                    except (ValueError, TypeError, KeyError):
                        actions = []
                    out.write(json.dumps({"planHash": plan["planHash"], "id": trial["id"],
                                          "actions": actions, "usage": usage}) + "\n")
                    out.flush()
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        reason = error.args[0] if isinstance(error, ValueError) and error.args else ""
        print("Capture halted: " + (reason if reason in (
            "stored-login-unavailable", "confinement-probe-failed", "model-call-failed",
            "public-pack-mismatch", "plan-hash-mismatch",
            "public-plan-and-model-required", "limit-must-cover-whole-three-arm-sets",
            "unconfined-or-unverified-session", "tool-activity",
        ) else type(error).__name__), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
