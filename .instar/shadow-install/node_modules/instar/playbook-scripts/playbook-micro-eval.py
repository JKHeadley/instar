#!/usr/bin/env python3
"""
Playbook Micro-Level Evaluation — per-action outcome-linked logging.

Part of Playbook Phase 2 (context-engineering-integration spec, Section 4.4).

Extends playbook-eval-log.py (Phase 1, session-level) with per-action granularity.
After each significant action (deploy, test, API call, build), this script
appends a micro-level eval entry to the session's eval-log. Each entry records:
  - What action was taken
  - Whether it succeeded or failed (outcome-linked via exit code, HTTP status, etc.)
  - Which context items were loaded for the task (from assembly log)
  - Which items were actually used (if specified)
  - Domain of the action (for causal sanity check)

The micro-level entries feed into the meso-level evaluator at session end,
which aggregates them into delta proposals.

Usage:
    python3 playbook-micro-eval.py log <session_id> <action> [options]
    python3 playbook-micro-eval.py read <session_id>
    python3 playbook-micro-eval.py summary <session_id>

    Options:
        --exit-code N       Exit code of the action
        --http-status N     HTTP status code
        --domain DOMAIN     Action domain (e.g., "database", "deployment")
        --used-items ID,ID  Comma-separated list of specific item IDs used
        --lesson TEXT        Candidate micro-lesson discovered during action

Library usage:
    from playbook_micro_eval import log_micro_eval, read_micro_evals, summarize_micro_evals
    log_micro_eval("AUT-2300-wo", "prisma-query", "success", exit_code=0, domain="database")
    entries = read_micro_evals("AUT-2300-wo")
    summary = summarize_micro_evals("AUT-2300-wo")
"""

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_append
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
ASSEMBLY_LOG = _paths.assembly_log
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")

VALID_OUTCOMES = ("success", "failure", "partial", "unknown")


def _get_eval_log_path(session_id):
    """Get the eval-log path for a session."""
    for suffix in ["-wo", ""]:
        session_dir = os.path.join(SESSIONS_DIR, f"{session_id}{suffix}")
        if os.path.exists(session_dir):
            return os.path.join(session_dir, "eval-log.jsonl")
    return None


def _get_loaded_items_for_session(session_id):
    """Read assembly log to find which context items were loaded for this session."""
    loaded = set()
    if not os.path.exists(ASSEMBLY_LOG):
        return sorted(loaded)
    with open(ASSEMBLY_LOG, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("session_id") == session_id:
                    for item_id in entry.get("selected", []):
                        if isinstance(item_id, str):
                            loaded.add(item_id)
                        elif isinstance(item_id, dict):
                            loaded.add(item_id.get("id", ""))
            except json.JSONDecodeError:
                continue
    return sorted(loaded)


def _build_evidence(exit_code=None, http_status=None, test_result=None):
    """Build evidence array from provided signals."""
    evidence = []
    if exit_code is not None:
        evidence.append({"type": "exit_code", "value": str(exit_code)})
    if http_status is not None:
        evidence.append({"type": "http_status", "value": str(http_status)})
    if test_result is not None:
        evidence.append({"type": "test_result", "value": str(test_result)})
    return evidence


def _determine_outcome(exit_code=None, http_status=None):
    """Determine outcome from evidence signals."""
    if exit_code is not None:
        return "success" if exit_code == 0 else "failure"
    if http_status is not None:
        if 200 <= http_status < 300:
            return "success"
        if 300 <= http_status < 400:
            return "partial"
        return "failure"
    return "unknown"


def log_micro_eval(session_id, action, outcome=None, *,
                   exit_code=None, http_status=None, test_result=None,
                   domain=None, used_items=None, lesson_candidate=None):
    """
    Log a micro-level evaluation entry for a single action.

    Args:
        session_id: Current session ID (e.g., "AUT-2300-wo")
        action: Action name (e.g., "prisma-query", "deploy-vercel", "run-tests")
        outcome: "success"/"failure"/"partial"/"unknown". Auto-determined if not provided.
        exit_code: Process exit code (0 = success)
        http_status: HTTP response status code
        test_result: Test result string (e.g., "passed", "5/5 passed")
        domain: Action domain for causal sanity check (e.g., "database", "deployment")
        used_items: List of specific item IDs that informed this action
        lesson_candidate: Text of a micro-lesson discovered during this action

    Returns:
        The eval entry dict that was logged, or None if session dir not found.
    """
    eval_log_path = _get_eval_log_path(session_id)
    if not eval_log_path:
        return None

    if outcome is None:
        outcome = _determine_outcome(exit_code, http_status)
    if outcome not in VALID_OUTCOMES:
        outcome = "unknown"

    evidence = _build_evidence(exit_code, http_status, test_result)
    context_loaded = _get_loaded_items_for_session(session_id)

    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": session_id,
        "type": "micro_eval",
        "action": action,
        "outcome": outcome,
        "evidence": evidence,
        "context_loaded": context_loaded,
        "outcome_linked": len(evidence) > 0,
    }

    if domain:
        entry["domain"] = domain
    if used_items:
        entry["used_items"] = used_items
    if lesson_candidate:
        entry["lesson_candidate"] = lesson_candidate

    os.makedirs(os.path.dirname(eval_log_path), exist_ok=True)
    atomic_append(eval_log_path, json.dumps(entry, separators=(",", ":")))

    return entry


def read_micro_evals(session_id):
    """Read all micro-level eval entries for a session."""
    eval_log_path = _get_eval_log_path(session_id)
    if not eval_log_path or not os.path.exists(eval_log_path):
        return []

    entries = []
    with open(eval_log_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("type") == "micro_eval":
                    entries.append(entry)
            except json.JSONDecodeError:
                continue
    return entries


def summarize_micro_evals(session_id):
    """
    Summarize micro-level evals for a session.

    Returns dict with counts, item attribution, lesson candidates, and active domains.
    This summary feeds into the meso-level evaluator for delta proposals.
    """
    entries = read_micro_evals(session_id)
    summary = {
        "total_actions": len(entries),
        "success_count": 0,
        "failure_count": 0,
        "partial_count": 0,
        "unknown_count": 0,
        "items_attributed": {},
        "lesson_candidates": [],
        "domains_active": set(),
    }

    for entry in entries:
        outcome = entry.get("outcome", "unknown")
        if outcome == "success":
            summary["success_count"] += 1
        elif outcome == "failure":
            summary["failure_count"] += 1
        elif outcome == "partial":
            summary["partial_count"] += 1
        else:
            summary["unknown_count"] += 1

        domain = entry.get("domain")
        if domain:
            summary["domains_active"].add(domain)

        # Attribution: used_items if specified, else context_loaded
        attributed_items = entry.get("used_items") or entry.get("context_loaded", [])
        for item_id in attributed_items:
            if item_id not in summary["items_attributed"]:
                summary["items_attributed"][item_id] = {"helpful": 0, "used_in": 0}
            summary["items_attributed"][item_id]["used_in"] += 1
            if outcome == "success":
                summary["items_attributed"][item_id]["helpful"] += 1
            elif outcome == "partial":
                summary["items_attributed"][item_id]["helpful"] += 0.5

        lesson = entry.get("lesson_candidate")
        if lesson:
            summary["lesson_candidates"].append({
                "text": lesson,
                "action": entry.get("action"),
                "domain": domain,
                "timestamp": entry.get("timestamp"),
            })

    summary["domains_active"] = sorted(summary["domains_active"])
    return summary


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "log":
        if len(sys.argv) < 4:
            print("Usage: playbook-micro-eval.py log <session_id> <action> [options]")
            sys.exit(1)
        session_id = sys.argv[2]
        action = sys.argv[3]

        kwargs = {}
        i = 4
        outcome = None
        while i < len(sys.argv):
            arg = sys.argv[i]
            if arg == "--exit-code" and i + 1 < len(sys.argv):
                kwargs["exit_code"] = int(sys.argv[i + 1])
                i += 2
            elif arg == "--http-status" and i + 1 < len(sys.argv):
                kwargs["http_status"] = int(sys.argv[i + 1])
                i += 2
            elif arg == "--domain" and i + 1 < len(sys.argv):
                kwargs["domain"] = sys.argv[i + 1]
                i += 2
            elif arg == "--used-items" and i + 1 < len(sys.argv):
                kwargs["used_items"] = sys.argv[i + 1].split(",")
                i += 2
            elif arg == "--lesson" and i + 1 < len(sys.argv):
                kwargs["lesson_candidate"] = sys.argv[i + 1]
                i += 2
            elif arg in VALID_OUTCOMES:
                outcome = arg
                i += 1
            else:
                i += 1

        entry = log_micro_eval(session_id, action, outcome, **kwargs)
        if entry:
            print(json.dumps(entry, indent=2))
        else:
            print(f"Could not log: session dir not found for {session_id}", file=sys.stderr)
            sys.exit(1)

    elif cmd == "read":
        session_id = sys.argv[2]
        entries = read_micro_evals(session_id)
        if not entries:
            print(f"No micro-eval entries for {session_id}")
        else:
            for entry in entries:
                print(json.dumps(entry, indent=2))

    elif cmd == "summary":
        session_id = sys.argv[2]
        summary = summarize_micro_evals(session_id)
        print(json.dumps(summary, indent=2))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
