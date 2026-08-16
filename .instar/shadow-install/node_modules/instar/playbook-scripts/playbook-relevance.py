#!/usr/bin/env python3
"""
Playbook Relevance Scoring Job — weekly scoring when manifest > 80% capacity.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 4.8 Cycle 3).

Orchestrates the relevance scoring cycle:
  1. Check if manifest is above capacity threshold (80% of caps)
  2. Score all items using decay functions
  3. Identify retirement candidates (below threshold, past grace)
  4. Generate retirement report for human review
  5. Optionally submit retirement deltas

Usage:
    python3 playbook-relevance.py run [--dry-run]     # Full relevance cycle
    python3 playbook-relevance.py report               # Just generate report
    python3 playbook-relevance.py candidates            # List retirement candidates

Library usage:
    from playbook_relevance import run_relevance_cycle, get_retirement_report
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
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
RELEVANCE_LOG = os.path.join(PROJECT_DIR, "context-relevance-log.jsonl")

# Minimum relevance score to avoid retirement consideration
DEFAULT_RETIREMENT_THRESHOLD = 0.1


def _import_decay():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_decay",
        os.path.join(SCRIPT_DIR, "playbook-decay.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def get_retirement_report(manifest=None, governance=None, threshold=None):
    """
    Generate a retirement report with scored items and candidates.

    Returns dict with full scoring results and retirement candidates.
    """
    decay = _import_decay()

    if manifest is None:
        manifest = _load_manifest()
    if governance is None:
        governance = _load_governance()
    if threshold is None:
        threshold = DEFAULT_RETIREMENT_THRESHOLD

    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    # Check capacity
    over_threshold, capacity_info = decay.check_capacity(manifest, governance)

    # Score all items
    scored = decay.score_all_items(manifest, governance)
    if isinstance(scored, dict) and scored.get("status") == "error":
        return scored

    # Find candidates
    candidates = []
    grace_items = []
    exempt_items = []

    for item in scored:
        rel = item["relevance"]
        if rel["is_exempt"]:
            exempt_items.append(item)
        elif rel["grace_period"]:
            grace_items.append(item)
        elif rel["score"] < threshold:
            candidates.append(item)

    return {
        "status": "complete",
        "capacity": capacity_info,
        "over_capacity_threshold": over_threshold,
        "total_scored": len(scored),
        "retirement_threshold": threshold,
        "candidates": candidates,
        "grace_items": grace_items,
        "exempt_items": len(exempt_items),
        "all_scores": scored,
    }


def run_relevance_cycle(dry_run=True, force=False, threshold=None):
    """
    Run the full relevance scoring cycle.

    Only runs if manifest > 80% capacity (unless force=True).
    Generates retirement deltas for candidates.
    """
    import secrets
    decay = _import_decay()

    manifest = _load_manifest()
    governance = _load_governance()

    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    if threshold is None:
        threshold = DEFAULT_RETIREMENT_THRESHOLD

    # Check capacity gate
    over_threshold, capacity_info = decay.check_capacity(manifest, governance)
    if not over_threshold and not force:
        return {
            "status": "below_capacity",
            "message": "Manifest below capacity threshold. No scoring needed.",
            "capacity": capacity_info,
        }

    # Generate report
    report = get_retirement_report(manifest, governance, threshold)
    if report.get("status") == "error":
        return report

    candidates = report.get("candidates", [])

    # Generate retirement deltas
    deltas = []
    for candidate in candidates:
        delta = {
            "delta_id": f"delta-{secrets.token_hex(6)}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_session": "RELEVANCE_SCORING",
            "operation": "retire",
            "target_item_id": candidate["id"],
            "reflector_confidence": 0.80,
            "payload": {
                "reason": "relevance_decay",
                "relevance_score": candidate["relevance"]["score"],
                "decay_rate": candidate["relevance"]["decay_rate"],
                "days_since_fresh": candidate["relevance"]["days_since_fresh"],
            },
            "evidence": [{
                "type": "test_result",
                "value": f"relevance_score:{candidate['relevance']['score']:.4f}<{threshold}",
            }],
        }
        deltas.append(delta)

    # Submit deltas if not dry run
    if not dry_run and deltas:
        try:
            from playbook_lifecycle import submit_delta
        except ImportError:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "playbook_lifecycle",
                os.path.join(SCRIPT_DIR, "playbook-lifecycle.py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            submit_delta = mod.submit_delta

        for delta in deltas:
            submit_delta(delta)

    # Log the cycle
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "over_capacity": over_threshold,
        "forced": force,
        "total_scored": report["total_scored"],
        "candidates": len(candidates),
        "deltas_proposed": len(deltas),
        "dry_run": dry_run,
    }
    atomic_append(RELEVANCE_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "complete",
        "capacity": capacity_info,
        "total_scored": report["total_scored"],
        "candidates": len(candidates),
        "grace_items": len(report.get("grace_items", [])),
        "exempt_items": report.get("exempt_items", 0),
        "deltas_proposed": len(deltas),
        "dry_run": dry_run,
        "retirement_details": [
            {"id": c["id"], "score": c["relevance"]["score"]}
            for c in candidates
        ],
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "run":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        force = "--force" in sys.argv
        result = run_relevance_cycle(dry_run=dry_run, force=force)
        print(json.dumps(result, indent=2))

    elif cmd == "report":
        report = get_retirement_report()
        if report.get("status") == "error":
            print(report["message"], file=sys.stderr)
            sys.exit(1)
        print(f"Total scored: {report['total_scored']}")
        print(f"Retirement candidates: {len(report['candidates'])}")
        print(f"Items in grace: {len(report['grace_items'])}")
        print(f"Exempt items: {report['exempt_items']}")
        if report["candidates"]:
            print("\nRetirement candidates:")
            for c in report["candidates"]:
                print(f"  {c['id']}: score={c['relevance']['score']:.4f}")

    elif cmd == "candidates":
        report = get_retirement_report()
        if report.get("status") == "error":
            print(report["message"], file=sys.stderr)
            sys.exit(1)
        candidates = report.get("candidates", [])
        if not candidates:
            print("No retirement candidates.")
        else:
            for c in candidates:
                print(f"  {c['id']}: score={c['relevance']['score']:.4f} "
                      f"type={c['memory_type']}")

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
