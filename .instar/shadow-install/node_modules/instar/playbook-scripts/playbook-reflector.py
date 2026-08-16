#!/usr/bin/env python3
"""
Playbook 2-Round Reflector — propose/critique/finalize cycle for delta quality.

Part of Playbook Phase 2 (context-engineering-integration spec, Section 6.1).

Implements a 2-round refinement cycle for proposed deltas:
  Round 1 (Propose): Generate initial deltas from eval-log data
  Round 2 (Critique): Review proposed deltas for quality issues
  Finalize: Apply critique findings to produce refined deltas

The critique round catches:
  - Overly broad counter updates (item not causally related)
  - Missing evidence (delta lacks concrete outcome linkage)
  - Confidence inflation (confidence too high for evidence quality)
  - Stale attributions (item no longer relevant to current patterns)

This is a DETERMINISTIC critique (not LLM-based) — per spec, the reflector
output is treated as untrusted, so the critique is a structural quality gate.

Usage:
    python3 playbook-reflector.py reflect <session_id>    # Full 2-round cycle
    python3 playbook-reflector.py critique <deltas_json>   # Critique proposed deltas

Library usage:
    from playbook_reflector import two_round_reflect, critique_deltas
"""

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance

# Critique thresholds
MIN_EVIDENCE_ENTRIES = 1
MAX_HELPFUL_PER_SESSION = 10  # Flag if proposing more than this many helpful increments
CONFIDENCE_EVIDENCE_RATIO = {
    0: 0.0,    # No evidence -> 0 confidence
    1: 0.85,   # 1 evidence entry -> max 0.85
    2: 0.90,   # 2 entries -> max 0.90
    3: 0.95,   # 3+ entries -> max 0.95
}


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _load_governance():
    if not os.path.exists(GOVERNANCE_FILE):
        return None
    with open(GOVERNANCE_FILE, "r") as f:
        return json.load(f)


def _import_eval_log():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_eval_log",
        os.path.join(SCRIPT_DIR, "playbook-eval-log.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def critique_deltas(deltas, manifest=None):
    """
    Round 2: Critique proposed deltas for quality issues.

    Returns list of critique findings and adjusted deltas.
    Each finding is:
        {"delta_id": str, "issue": str, "severity": str, "action": str}

    Actions: "keep", "adjust_confidence", "drop", "flag_for_review"
    """
    if manifest is None:
        manifest = _load_manifest()

    governance = _load_governance()
    manifest_items = {}
    if manifest:
        for item in manifest.get("items", []):
            manifest_items[item["id"]] = item

    findings = []
    adjusted_deltas = []

    # Check for bulk inflation (too many helpful increments from one session)
    session_counts = {}
    for delta in deltas:
        session = delta.get("source_session", "")
        if delta.get("operation") == "update_counter":
            field = delta.get("payload", {}).get("field", "")
            if field == "helpful":
                session_counts[session] = session_counts.get(session, 0) + 1

    for delta in deltas:
        delta_id = delta.get("delta_id", "?")
        issues = []

        # Critique 1: Evidence quality
        evidence = delta.get("evidence", [])
        if len(evidence) < MIN_EVIDENCE_ENTRIES:
            issues.append({
                "delta_id": delta_id,
                "issue": "no_evidence",
                "severity": "high",
                "action": "drop",
                "detail": "Delta has no evidence entries",
            })

        # Critique 2: Confidence vs evidence ratio
        evidence_count = len(evidence)
        max_allowed = CONFIDENCE_EVIDENCE_RATIO.get(
            min(evidence_count, 3), 0.95)
        if delta.get("reflector_confidence", 0) > max_allowed:
            adjusted_confidence = max_allowed
            issues.append({
                "delta_id": delta_id,
                "issue": "confidence_inflation",
                "severity": "medium",
                "action": "adjust_confidence",
                "detail": f"Confidence {delta['reflector_confidence']} > max {max_allowed} for {evidence_count} evidence entries",
                "adjusted_to": adjusted_confidence,
            })
            delta = dict(delta)
            delta["reflector_confidence"] = adjusted_confidence

        # Critique 3: Bulk inflation guard
        session = delta.get("source_session", "")
        if session_counts.get(session, 0) > MAX_HELPFUL_PER_SESSION:
            if delta.get("operation") == "update_counter":
                issues.append({
                    "delta_id": delta_id,
                    "issue": "bulk_inflation",
                    "severity": "medium",
                    "action": "flag_for_review",
                    "detail": f"Session {session} proposing {session_counts[session]} helpful increments (max {MAX_HELPFUL_PER_SESSION})",
                })

        # Critique 4: Target item exists and is active
        target = delta.get("target_item_id", "")
        if target and target in manifest_items:
            item = manifest_items[target]
            if item.get("status") != "active":
                issues.append({
                    "delta_id": delta_id,
                    "issue": "target_not_active",
                    "severity": "high",
                    "action": "drop",
                    "detail": f"Target {target} has status '{item.get('status')}'",
                })

            # Critique 5: Category is scoring-eligible
            if governance:
                category = item.get("category", "")
                policy = governance.get("category_policies", {}).get(category, {})
                if policy.get("scoring_exempt", False):
                    issues.append({
                        "delta_id": delta_id,
                        "issue": "scoring_exempt",
                        "severity": "high",
                        "action": "drop",
                        "detail": f"Target {target} category '{category}' is scoring-exempt",
                    })
        elif target and delta.get("operation") != "create":
            issues.append({
                "delta_id": delta_id,
                "issue": "target_not_found",
                "severity": "high",
                "action": "drop",
                "detail": f"Target {target} not found in manifest",
            })

        findings.extend(issues)

        # Determine final action
        drop_issues = [i for i in issues if i.get("action") == "drop"]
        if drop_issues:
            continue  # Don't include this delta
        else:
            adjusted_deltas.append(delta)

    return {
        "findings": findings,
        "original_count": len(deltas),
        "refined_count": len(adjusted_deltas),
        "dropped": len(deltas) - len(adjusted_deltas),
        "deltas": adjusted_deltas,
    }


def two_round_reflect(session_id):
    """
    Full 2-round reflection cycle for a session.

    Round 1: Generate proposed deltas (via eval-log)
    Round 2: Critique and refine
    Returns: Refined deltas ready for submission
    """
    eval_log = _import_eval_log()

    # Round 1: Propose
    eval_log.generate_eval_log(session_id)
    proposed = eval_log.propose_deltas(session_id)

    if not proposed:
        return {
            "status": "no_deltas",
            "session_id": session_id,
            "round1_proposed": 0,
            "round2_refined": 0,
        }

    # Round 2: Critique
    critique_result = critique_deltas(proposed)

    return {
        "status": "complete",
        "session_id": session_id,
        "round1_proposed": len(proposed),
        "round2_findings": len(critique_result["findings"]),
        "round2_refined": critique_result["refined_count"],
        "round2_dropped": critique_result["dropped"],
        "deltas": critique_result["deltas"],
        "findings": critique_result["findings"],
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "reflect" and len(sys.argv) >= 3:
        session_id = sys.argv[2]
        result = two_round_reflect(session_id)
        print(json.dumps(result, indent=2))

    elif cmd == "critique" and len(sys.argv) >= 3:
        deltas = json.loads(sys.argv[2])
        result = critique_deltas(deltas)
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
