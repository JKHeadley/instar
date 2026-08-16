#!/usr/bin/env python3
"""
Playbook Governed Scratchpad — survives compaction boundaries.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.5).

A structured working memory space that persists across compaction boundaries
within a session. Uses atomic writes with SHA-256 checksum verification
to ensure integrity.

Usage:
    python3 playbook-scratchpad.py init <session_id>
    python3 playbook-scratchpad.py add-strategy <session_id> <domain> <insight> [--confidence 0.95] [--source-action "..."]
    python3 playbook-scratchpad.py add-failure <session_id> <pattern> <description> [--workaround "..."]
    python3 playbook-scratchpad.py add-hypothesis <session_id> <about> <hypothesis> [--evidence-for '["..."]']
    python3 playbook-scratchpad.py record-usage <session_id> <item_id> <action> <outcome> [--exit-code N]
    python3 playbook-scratchpad.py read <session_id>
    python3 playbook-scratchpad.py verify <session_id>
    python3 playbook-scratchpad.py summary <session_id>
"""

import hashlib
import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_write_json, compute_checksum
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")

MAX_STRATEGIES = 50
MAX_FAILURES = 50
MAX_HYPOTHESES = 50
MAX_USAGE_RECORDS = 200


def _scratchpad_path(session_id):
    return os.path.join(SESSIONS_DIR, session_id, "scratchpad.json")


def _compute_content_checksum(data):
    """Compute checksum of scratchpad content (excluding the checksum field)."""
    data_copy = {k: v for k, v in data.items() if k != "sha256_checksum"}
    canonical = json.dumps(data_copy, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return compute_checksum(canonical)


def init_scratchpad(session_id):
    """Initialize a new scratchpad for a session."""
    path = _scratchpad_path(session_id)
    if os.path.exists(path):
        return load_scratchpad(session_id)

    data = {
        "session_id": session_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "strategies_discovered": [],
        "failure_patterns": [],
        "active_hypotheses": [],
        "context_items_used_this_session": [],
        "outcome_linked_results": [],
    }
    data["sha256_checksum"] = _compute_content_checksum(data)
    atomic_write_json(path, data)
    return data


def load_scratchpad(session_id):
    """Load and verify a scratchpad. Returns None if corrupt."""
    path = _scratchpad_path(session_id)
    if not os.path.exists(path):
        return None

    with open(path, "r") as f:
        data = json.load(f)

    stored_checksum = data.get("sha256_checksum", "")
    expected_checksum = _compute_content_checksum(data)

    if stored_checksum != expected_checksum:
        print(f"WARNING: Scratchpad checksum mismatch for {session_id}", file=sys.stderr)
        print(f"  stored:   {stored_checksum}", file=sys.stderr)
        print(f"  expected: {expected_checksum}", file=sys.stderr)
        return None

    return data


def _save_scratchpad(session_id, data):
    """Save scratchpad with updated checksum."""
    data["sha256_checksum"] = _compute_content_checksum(data)
    path = _scratchpad_path(session_id)
    atomic_write_json(path, data)
    return data


def add_strategy(session_id, domain, insight, confidence=0.9, source_action="", sub_agent_eligible=False):
    """Add a discovered strategy to the scratchpad."""
    data = load_scratchpad(session_id)
    if data is None:
        data = init_scratchpad(session_id)

    if len(data["strategies_discovered"]) >= MAX_STRATEGIES:
        print(f"WARNING: Max strategies ({MAX_STRATEGIES}) reached", file=sys.stderr)
        return data

    strat_id = f"strat-{len(data['strategies_discovered']) + 1:03d}"
    data["strategies_discovered"].append({
        "id": strat_id,
        "domain": domain,
        "insight": insight,
        "confidence": confidence,
        "source_action": source_action,
        "times_used": 0,
        "sub_agent_eligible": sub_agent_eligible,
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })

    return _save_scratchpad(session_id, data)


def add_failure_pattern(session_id, pattern, description, workaround=""):
    """Add a failure pattern to the scratchpad."""
    data = load_scratchpad(session_id)
    if data is None:
        data = init_scratchpad(session_id)

    if len(data["failure_patterns"]) >= MAX_FAILURES:
        print(f"WARNING: Max failure patterns ({MAX_FAILURES}) reached", file=sys.stderr)
        return data

    data["failure_patterns"].append({
        "pattern": pattern,
        "description": description,
        "occurrences": 1,
        "workaround": workaround,
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })

    return _save_scratchpad(session_id, data)


def add_hypothesis(session_id, about, hypothesis, evidence_for=None, evidence_against=None):
    """Add an active hypothesis to the scratchpad."""
    data = load_scratchpad(session_id)
    if data is None:
        data = init_scratchpad(session_id)

    if len(data["active_hypotheses"]) >= MAX_HYPOTHESES:
        print(f"WARNING: Max hypotheses ({MAX_HYPOTHESES}) reached", file=sys.stderr)
        return data

    data["active_hypotheses"].append({
        "about": about,
        "hypothesis": hypothesis,
        "evidence_for": evidence_for or [],
        "evidence_against": evidence_against or [],
        "status": "investigating",
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })

    return _save_scratchpad(session_id, data)


def record_usage(session_id, item_id, action, outcome, exit_code=None):
    """Record outcome-linked usage of a context item."""
    data = load_scratchpad(session_id)
    if data is None:
        data = init_scratchpad(session_id)

    if item_id not in data["context_items_used_this_session"]:
        data["context_items_used_this_session"].append(item_id)

    if len(data["outcome_linked_results"]) >= MAX_USAGE_RECORDS:
        data["outcome_linked_results"] = data["outcome_linked_results"][-MAX_USAGE_RECORDS + 1:]

    record = {
        "item_id": item_id,
        "action": action,
        "outcome": outcome,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if exit_code is not None:
        record["exit_code"] = exit_code

    data["outcome_linked_results"].append(record)

    return _save_scratchpad(session_id, data)


def verify_scratchpad(session_id):
    """Verify scratchpad integrity. Returns dict with valid status."""
    path = _scratchpad_path(session_id)
    if not os.path.exists(path):
        return {"valid": False, "error": "File not found"}

    try:
        with open(path, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return {"valid": False, "error": f"Invalid JSON: {e}"}

    stored = data.get("sha256_checksum", "")
    expected = _compute_content_checksum(data)

    if stored != expected:
        return {
            "valid": False,
            "error": "Checksum mismatch",
            "stored": stored,
            "expected": expected,
        }

    return {
        "valid": True,
        "session_id": data.get("session_id"),
        "strategies": len(data.get("strategies_discovered", [])),
        "failures": len(data.get("failure_patterns", [])),
        "hypotheses": len(data.get("active_hypotheses", [])),
        "items_used": len(data.get("context_items_used_this_session", [])),
        "outcomes": len(data.get("outcome_linked_results", [])),
    }


def summary(session_id):
    """Get a compact summary of the scratchpad."""
    data = load_scratchpad(session_id)
    if data is None:
        return "No valid scratchpad found"

    lines = [f"Scratchpad: {session_id}"]
    lines.append(f"  Strategies: {len(data['strategies_discovered'])}")
    lines.append(f"  Failures:   {len(data['failure_patterns'])}")
    lines.append(f"  Hypotheses: {len(data['active_hypotheses'])}")
    lines.append(f"  Items used: {len(data['context_items_used_this_session'])}")
    lines.append(f"  Outcomes:   {len(data['outcome_linked_results'])}")

    if data["strategies_discovered"]:
        lines.append("  Recent strategies:")
        for s in data["strategies_discovered"][-3:]:
            lines.append(f"    [{s['domain']}] {s['insight'][:80]}...")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "init":
        if len(sys.argv) < 3:
            print("Usage: playbook-scratchpad.py init <session_id>", file=sys.stderr)
            sys.exit(1)
        data = init_scratchpad(sys.argv[2])
        print(json.dumps(data, indent=2))

    elif cmd == "add-strategy":
        if len(sys.argv) < 5:
            print("Usage: playbook-scratchpad.py add-strategy <session_id> <domain> <insight> [--confidence N] [--source-action S]", file=sys.stderr)
            sys.exit(1)
        kwargs = {}
        if "--confidence" in sys.argv:
            idx = sys.argv.index("--confidence")
            kwargs["confidence"] = float(sys.argv[idx + 1])
        if "--source-action" in sys.argv:
            idx = sys.argv.index("--source-action")
            kwargs["source_action"] = sys.argv[idx + 1]
        data = add_strategy(sys.argv[2], sys.argv[3], sys.argv[4], **kwargs)
        print(f"Added strategy in {sys.argv[3]} domain. Total: {len(data['strategies_discovered'])}")

    elif cmd == "add-failure":
        if len(sys.argv) < 5:
            print("Usage: playbook-scratchpad.py add-failure <session_id> <pattern> <description> [--workaround S]", file=sys.stderr)
            sys.exit(1)
        workaround = ""
        if "--workaround" in sys.argv:
            idx = sys.argv.index("--workaround")
            workaround = sys.argv[idx + 1]
        data = add_failure_pattern(sys.argv[2], sys.argv[3], sys.argv[4], workaround)
        print(f"Added failure pattern. Total: {len(data['failure_patterns'])}")

    elif cmd == "add-hypothesis":
        if len(sys.argv) < 5:
            print("Usage: playbook-scratchpad.py add-hypothesis <session_id> <about> <hypothesis>", file=sys.stderr)
            sys.exit(1)
        evidence_for = []
        if "--evidence-for" in sys.argv:
            idx = sys.argv.index("--evidence-for")
            evidence_for = json.loads(sys.argv[idx + 1])
        data = add_hypothesis(sys.argv[2], sys.argv[3], sys.argv[4], evidence_for)
        print(f"Added hypothesis. Total: {len(data['active_hypotheses'])}")

    elif cmd == "record-usage":
        if len(sys.argv) < 6:
            print("Usage: playbook-scratchpad.py record-usage <session_id> <item_id> <action> <outcome> [--exit-code N]", file=sys.stderr)
            sys.exit(1)
        exit_code = None
        if "--exit-code" in sys.argv:
            idx = sys.argv.index("--exit-code")
            exit_code = int(sys.argv[idx + 1])
        data = record_usage(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], exit_code)
        print(f"Recorded usage. Total outcomes: {len(data['outcome_linked_results'])}")

    elif cmd == "read":
        if len(sys.argv) < 3:
            print("Usage: playbook-scratchpad.py read <session_id>", file=sys.stderr)
            sys.exit(1)
        data = load_scratchpad(sys.argv[2])
        if data:
            print(json.dumps(data, indent=2))
        else:
            print("No valid scratchpad found", file=sys.stderr)
            sys.exit(1)

    elif cmd == "verify":
        if len(sys.argv) < 3:
            print("Usage: playbook-scratchpad.py verify <session_id>", file=sys.stderr)
            sys.exit(1)
        result = verify_scratchpad(sys.argv[2])
        print(json.dumps(result, indent=2))
        if not result["valid"]:
            sys.exit(1)

    elif cmd == "summary":
        if len(sys.argv) < 3:
            print("Usage: playbook-scratchpad.py summary <session_id>", file=sys.stderr)
            sys.exit(1)
        print(summary(sys.argv[2]))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
