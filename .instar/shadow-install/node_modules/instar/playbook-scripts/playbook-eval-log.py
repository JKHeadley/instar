#!/usr/bin/env python3
"""
Playbook Eval-Log — structured evaluation logging for session reflection.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.4).

Produces structured eval-log entries at session end that connect context items
to session outcomes. This bridges `/reflect` (which extracts lessons) with the
Playbook system (which tracks which context items are helpful).

Eval-log entries contain:
  - Which context items were loaded (from assembly log)
  - Whether actions succeeded or failed (outcome-linked)
  - Proposed delta updates to manifest counters
  - reflector_confidence scores for each proposed delta

The `/reflect` skill calls this script to generate eval-log entries,
which are then processed by the lifecycle job.

Usage:
    python3 playbook-eval-log.py generate <session_id>
    python3 playbook-eval-log.py read <session_id>
    python3 playbook-eval-log.py propose-deltas <session_id>

Library usage:
    from playbook_eval_log import generate_eval_log, propose_deltas
    entries = generate_eval_log("AUT-2279-wo")
    deltas = propose_deltas("AUT-2279-wo")
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

# Minimum confidence for deltas to go to standard processing
CONFIDENCE_THRESHOLD = 0.85

# Phase 2: Confidence levels based on evidence strength
CONFIDENCE_MICRO_ONLY = 0.85       # Micro-eval evidence (outcome-linked)
CONFIDENCE_MICRO_WITH_DOMAIN = 0.90  # Micro-eval + domain match
CONFIDENCE_SESSION_REPORT_ONLY = 0.80  # Session report heuristics (weaker signal)


def _import_micro_eval():
    """Import micro-eval module."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_micro_eval",
        os.path.join(SCRIPT_DIR, "playbook-micro-eval.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_assembly_log(session_id):
    """Read assembly log entries for a given session."""
    entries = []
    if not os.path.exists(ASSEMBLY_LOG):
        return entries
    with open(ASSEMBLY_LOG, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if entry.get("session_id") == session_id:
                    entries.append(entry)
            except json.JSONDecodeError:
                continue
    return entries


def _read_session_report(session_id):
    """Read the session report to extract outcome signals."""
    # Try the -wo suffix variant first (worktree sessions)
    for suffix in ["-wo", ""]:
        report_path = os.path.join(SESSIONS_DIR, f"{session_id}{suffix}", "report.md")
        if os.path.exists(report_path):
            with open(report_path, "r", errors="replace") as f:
                return f.read()
    return None


def _extract_outcome_signals(report_content):
    """
    Extract outcome signals from a session report.

    Looks for patterns that indicate success or failure:
    - Commits made (success signal)
    - Tests passing (success signal)
    - Errors encountered (failure signal)
    - Blocked items (failure signal)
    """
    if not report_content:
        return {"overall": "unknown", "signals": []}

    signals = []
    content_lower = report_content.lower()

    # Success signals
    if "commit" in content_lower or "committed" in content_lower:
        signals.append({"type": "commit_made", "outcome": "success"})
    if "tests pass" in content_lower or "all tests" in content_lower:
        signals.append({"type": "tests_passed", "outcome": "success"})
    if "completed" in content_lower or "done" in content_lower:
        signals.append({"type": "task_completed", "outcome": "success"})

    # Failure signals
    if "error" in content_lower or "failed" in content_lower:
        signals.append({"type": "error_encountered", "outcome": "failure"})
    if "blocked" in content_lower:
        signals.append({"type": "blocked", "outcome": "failure"})

    # Overall assessment
    success_count = sum(1 for s in signals if s["outcome"] == "success")
    failure_count = sum(1 for s in signals if s["outcome"] == "failure")

    if success_count > failure_count:
        overall = "success"
    elif failure_count > success_count:
        overall = "failure"
    else:
        overall = "mixed"

    return {"overall": overall, "signals": signals}


def generate_eval_log(session_id):
    """
    Generate eval-log entries for a session.

    Phase 2 enhancement: Combines micro-level eval data (per-action outcomes)
    with assembly log data and session report data. Micro-level data is the
    primary signal (outcome-linked); session report is fallback.

    Returns list of eval-log entries.
    """
    # 1. Get assembly log entries for this session
    assembly_entries = _read_assembly_log(session_id)

    # 2. Phase 2: Get micro-eval summary (primary signal)
    micro_summary = None
    try:
        micro_mod = _import_micro_eval()
        micro_summary = micro_mod.summarize_micro_evals(session_id)
    except Exception:
        pass  # Fall back to session report only

    # 3. Get session report (fallback signal)
    report_content = _read_session_report(session_id)
    report_outcome = _extract_outcome_signals(report_content)

    # 4. Determine outcome — micro-eval data takes precedence
    if micro_summary and micro_summary.get("total_actions", 0) > 0:
        success = micro_summary["success_count"]
        failure = micro_summary["failure_count"]
        total = micro_summary["total_actions"]
        if success > failure:
            overall_outcome = "success"
        elif failure > success:
            overall_outcome = "failure"
        else:
            overall_outcome = "mixed"
        outcome_source = "micro_eval"
    else:
        overall_outcome = report_outcome["overall"]
        outcome_source = "session_report"

    # 5. Collect all context items that were loaded
    loaded_items = set()
    for entry in assembly_entries:
        for item in entry.get("selected", []):
            item_id = item.get("id", "")
            if item_id:
                loaded_items.add(item_id)

    # 6. Generate session-level eval entry
    eval_entries = []
    session_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": session_id,
        "type": "session_eval",
        "outcome": overall_outcome,
        "outcome_source": outcome_source,
        "outcome_signals": report_outcome["signals"],
        "context_loaded": sorted(loaded_items),
        "context_load_count": len(loaded_items),
        "assembly_events": len(assembly_entries),
        "outcome_linked": True,
    }

    # Phase 2: Include micro-eval summary if available
    if micro_summary and micro_summary.get("total_actions", 0) > 0:
        session_entry["micro_eval_summary"] = {
            "total_actions": micro_summary["total_actions"],
            "success_count": micro_summary["success_count"],
            "failure_count": micro_summary["failure_count"],
            "domains_active": micro_summary["domains_active"],
            "items_attributed": micro_summary["items_attributed"],
            "lesson_candidates_count": len(micro_summary.get("lesson_candidates", [])),
        }

    eval_entries.append(session_entry)

    # Write to session eval-log
    eval_log_path = _get_eval_log_path(session_id)
    if eval_log_path:
        os.makedirs(os.path.dirname(eval_log_path), exist_ok=True)
        for entry in eval_entries:
            atomic_append(eval_log_path, json.dumps(entry, separators=(",", ":")))

    return eval_entries


def _get_eval_log_path(session_id):
    """Get the eval-log path for a session."""
    for suffix in ["-wo", ""]:
        session_dir = os.path.join(SESSIONS_DIR, f"{session_id}{suffix}")
        if os.path.exists(session_dir):
            return os.path.join(session_dir, "eval-log.jsonl")
    # Create if session dir exists
    session_dir = os.path.join(SESSIONS_DIR, f"{session_id}-wo")
    if os.path.exists(session_dir):
        return os.path.join(session_dir, "eval-log.jsonl")
    return None


def propose_deltas(session_id):
    """
    Propose context deltas based on eval-log entries.

    For successful sessions: propose helpful counter increments
    for loaded context items (in their domain).

    For failed sessions: do NOT auto-increment misleading (requires
    3-signal minimum per spec).

    Returns list of proposed deltas ready for submission.
    """
    # Read eval-log
    eval_log_path = _get_eval_log_path(session_id)
    if not eval_log_path or not os.path.exists(eval_log_path):
        # Generate first
        generate_eval_log(session_id)
        if not eval_log_path or not os.path.exists(eval_log_path):
            return []

    entries = []
    with open(eval_log_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    if not entries:
        return []

    # Load manifest for category checking
    manifest_path = os.path.join(PROJECT_DIR, "context-manifest.json")
    manifest = None
    if os.path.exists(manifest_path):
        with open(manifest_path, "r") as f:
            manifest = json.load(f)

    manifest_items = {}
    if manifest:
        for item in manifest.get("items", []):
            manifest_items[item["id"]] = item

    # Load governance for category policies
    governance_path = os.path.join(PROJECT_DIR, "context-governance.json")
    governance = None
    if os.path.exists(governance_path):
        with open(governance_path, "r") as f:
            governance = json.load(f)

    category_policies = {}
    if governance:
        # category_policies is a dict of {name: policy} in governance
        category_policies = governance.get("category_policies", {})

    # Generate deltas
    import secrets
    deltas = []

    for entry in entries:
        if entry.get("type") != "session_eval":
            continue

        outcome = entry.get("outcome", "unknown")
        loaded_items = entry.get("context_loaded", [])

        # Phase 2: Use micro-eval attribution if available
        micro_attribution = entry.get("micro_eval_summary", {}).get("items_attributed", {})
        has_micro_data = bool(micro_attribution)

        if outcome in ("success", "mixed"):
            for item_id in loaded_items:
                item = manifest_items.get(item_id)
                if not item:
                    continue

                # Skip scoring-exempt categories
                category = item.get("category", "")
                policy = category_policies.get(category, {})
                if policy.get("scoring_exempt", False):
                    continue

                # Phase 2: Determine confidence based on attribution evidence
                if has_micro_data and item_id in micro_attribution:
                    attr = micro_attribution[item_id]
                    helpful_count = attr.get("helpful", 0)
                    used_count = attr.get("used_in", 0)
                    if helpful_count <= 0:
                        continue  # Item was loaded but not helpful in micro-evals
                    # Higher confidence when micro-eval data attributes helpfulness
                    confidence = CONFIDENCE_MICRO_WITH_DOMAIN
                    increment = 1 if helpful_count >= 1 else 0.5
                    evidence = [{"type": "exit_code", "value": "0"},
                                {"type": "test_result", "value": f"micro_eval:{helpful_count}/{used_count}"}]
                elif has_micro_data and item_id not in micro_attribution:
                    # Item was loaded but not attributed in any micro-eval
                    # Lower confidence — co-present but not causally linked
                    continue  # Skip: causal sanity check — not attributed
                else:
                    # No micro data: fall back to session-level (weaker signal)
                    confidence = CONFIDENCE_SESSION_REPORT_ONLY if outcome == "success" else 0.75
                    increment = 1 if outcome == "success" else 0.5
                    evidence = [{"type": "exit_code", "value": "0"}]

                delta = {
                    "delta_id": f"delta-{secrets.token_hex(6)}",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "source_session": session_id,
                    "operation": "update_counter",
                    "target_item_id": item_id,
                    "reflector_confidence": confidence,
                    "payload": {
                        "field": "helpful",
                        "increment": increment,
                    },
                    "evidence": evidence,
                }
                deltas.append(delta)

        # For failures: do NOT auto-increment misleading
        # Per spec: 3-signal minimum for misleading, requires specific
        # evidence that the item directly contributed to failure

    return deltas


def read_eval_log(session_id):
    """Read eval-log entries for a session."""
    eval_log_path = _get_eval_log_path(session_id)
    if not eval_log_path or not os.path.exists(eval_log_path):
        return []

    entries = []
    with open(eval_log_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return entries


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    session_id = sys.argv[2]

    if cmd == "generate":
        entries = generate_eval_log(session_id)
        print(f"Generated {len(entries)} eval-log entries for {session_id}")
        for entry in entries:
            print(json.dumps(entry, indent=2))

    elif cmd == "read":
        entries = read_eval_log(session_id)
        if not entries:
            print(f"No eval-log entries for {session_id}")
        else:
            for entry in entries:
                print(json.dumps(entry, indent=2))

    elif cmd == "propose-deltas":
        deltas = propose_deltas(session_id)
        if not deltas:
            print(f"No deltas to propose for {session_id}")
        else:
            print(f"Proposed {len(deltas)} deltas:")
            for delta in deltas:
                print(f"  {delta['delta_id']} [{delta['operation']}] -> {delta['target_item_id']} "
                      f"(confidence: {delta['reflector_confidence']})")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
