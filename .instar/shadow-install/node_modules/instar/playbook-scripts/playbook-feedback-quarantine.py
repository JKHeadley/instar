#!/usr/bin/env python3
"""
Playbook Sub-Agent Feedback Quarantine — corroboration-gated feedback pipeline.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 9).

When sub-agents return feedback about context items (e.g., "this item was helpful"),
the feedback goes to quarantine first. Only feedback that meets ALL corroboration
criteria can escape quarantine and update manifest counters via the lifecycle job.

Corroboration Criteria (ALL must pass):
  1. Outcome match: Parent session observes verifiable outcome consistent with claim
  2. Domain overlap: Feedback targets items in the domain the sub-agent was spawned for
  3. Confidence floor: promoted items have confidence >= 0.7
  4. Volume cap: Max 5 counter updates per sub-agent return
  5. No self-creation: Sub-agent feedback cannot create new manifest items

Usage:
    python3 playbook-feedback-quarantine.py submit <feedback_json>
    python3 playbook-feedback-quarantine.py corroborate <feedback_id> --outcome <json>
    python3 playbook-feedback-quarantine.py pending
    python3 playbook-feedback-quarantine.py stats
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
FEEDBACK_FILE = _paths.feedback_file
MANIFEST_FILE = _paths.manifest

# Corroboration constants
CONFIDENCE_FLOOR = 0.7
VOLUME_CAP = 5
ALLOWED_OPERATIONS = ["update_counter"]  # Sub-agents can only update counters


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _load_feedback_entries():
    """Load all feedback entries."""
    entries = []
    if not os.path.exists(FEEDBACK_FILE):
        return entries
    with open(FEEDBACK_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def submit_feedback(feedback):
    """
    Submit sub-agent feedback to quarantine.

    The feedback is stored but NOT applied to the manifest until corroborated.
    """
    if isinstance(feedback, str):
        feedback = json.loads(feedback)

    # Generate feedback ID if missing
    if "feedback_id" not in feedback:
        import secrets
        feedback["feedback_id"] = f"fb-{secrets.token_hex(6)}"

    # Ensure required fields
    feedback.setdefault("timestamp", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    feedback.setdefault("status", "pending")
    feedback.setdefault("corroborated", False)

    # Validate structure
    errors = _validate_feedback(feedback)
    if errors:
        feedback["status"] = "invalid"
        feedback["validation_errors"] = errors

    line = json.dumps(feedback, separators=(",", ":"))
    atomic_append(FEEDBACK_FILE, line)
    return feedback["feedback_id"], errors


def _validate_feedback(feedback):
    """Validate feedback structure."""
    errors = []

    if "source_agent" not in feedback:
        errors.append("Missing source_agent")
    if "parent_session" not in feedback:
        errors.append("Missing parent_session")
    if "items" not in feedback or not isinstance(feedback.get("items"), list):
        errors.append("Missing or invalid items array")
        return errors

    items = feedback["items"]

    # Volume cap check
    if len(items) > VOLUME_CAP:
        errors.append(f"Volume cap exceeded: {len(items)} items (max {VOLUME_CAP})")

    manifest = _load_manifest()
    manifest_items = {i["id"]: i for i in manifest.get("items", [])} if manifest else {}
    spawn_domain = feedback.get("spawn_domain", "")

    for i, item in enumerate(items):
        # Check required fields
        if "target_item_id" not in item:
            errors.append(f"items[{i}]: Missing target_item_id")
            continue

        target_id = item["target_item_id"]

        # No self-creation: only update_counter allowed
        operation = item.get("operation", "update_counter")
        if operation not in ALLOWED_OPERATIONS:
            errors.append(f"items[{i}]: Operation '{operation}' not allowed (only {ALLOWED_OPERATIONS})")

        # Confidence floor
        confidence = item.get("confidence", 0)
        if confidence < CONFIDENCE_FLOOR:
            errors.append(f"items[{i}]: Confidence {confidence} below floor {CONFIDENCE_FLOOR}")

        # Domain overlap check
        if spawn_domain and target_id in manifest_items:
            target_item = manifest_items[target_id]
            target_domains = set(target_item.get("tags", {}).get("domains", []))
            if spawn_domain not in target_domains and target_domains:
                errors.append(f"items[{i}]: Domain mismatch — spawned for '{spawn_domain}', "
                              f"targeting item in domains {target_domains}")

        # Check target exists
        if target_id not in manifest_items:
            errors.append(f"items[{i}]: Target item '{target_id}' not found in manifest")

    return errors


def corroborate_feedback(feedback_id, outcome):
    """
    Attempt to corroborate a pending feedback entry.

    Outcome should include verifiable evidence that the sub-agent's claim
    was correct (e.g., exit_code, http_status, test_result).

    If corroborated, generates deltas for the lifecycle job to process.
    """
    entries = _load_feedback_entries()
    found = None
    for entry in entries:
        if entry.get("feedback_id") == feedback_id:
            found = entry
            break

    if not found:
        return {"status": "not_found", "feedback_id": feedback_id}

    if found.get("status") != "pending":
        return {"status": "already_processed", "current_status": found["status"]}

    if found.get("validation_errors"):
        return {"status": "invalid", "errors": found["validation_errors"]}

    # Check outcome match
    if isinstance(outcome, str):
        outcome = json.loads(outcome)

    outcome_type = outcome.get("type", "")
    outcome_value = outcome.get("value", "")

    # Simple outcome matching: if outcome indicates success, corroborate
    success_indicators = {
        "exit_code": lambda v: str(v) == "0",
        "http_status": lambda v: str(v).startswith("2"),
        "test_result": lambda v: v.lower() in ("pass", "passed", "success", "true"),
        "human_verification": lambda v: v.lower() in ("yes", "confirmed", "correct", "true"),
    }

    checker = success_indicators.get(outcome_type)
    if not checker:
        return {"status": "unknown_outcome_type", "type": outcome_type}

    if not checker(outcome_value):
        # Outcome doesn't match — feedback stays in quarantine
        corroboration_entry = {
            "feedback_id": feedback_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "failed_corroboration",
            "outcome": outcome,
            "reason": f"Outcome {outcome_type}={outcome_value} does not indicate success",
        }
        atomic_append(FEEDBACK_FILE, json.dumps(corroboration_entry, separators=(",", ":")))
        return {"status": "failed", "reason": "Outcome does not indicate success"}

    # Corroboration passed — generate deltas
    deltas_generated = []
    items = found.get("items", [])[:VOLUME_CAP]

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_lifecycle",
        os.path.join(SCRIPT_DIR, "playbook-lifecycle.py"))
    lifecycle_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lifecycle_mod)

    for item in items:
        if item.get("confidence", 0) < CONFIDENCE_FLOOR:
            continue

        delta = {
            "operation": "update_counter",
            "target_item_id": item["target_item_id"],
            "source_session": found.get("parent_session", "unknown"),
            "reflector_confidence": item.get("confidence", CONFIDENCE_FLOOR),
            "payload": {
                "field": item.get("field", "helpful"),
                "increment": item.get("increment", 1),
            },
            "evidence": [{
                "type": outcome_type,
                "value": str(outcome_value),
            }],
        }
        delta_id = lifecycle_mod.submit_delta(delta)
        deltas_generated.append(delta_id)

    # Record corroboration
    corroboration_entry = {
        "feedback_id": feedback_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "corroborated",
        "outcome": outcome,
        "deltas_generated": deltas_generated,
    }
    atomic_append(FEEDBACK_FILE, json.dumps(corroboration_entry, separators=(",", ":")))

    return {
        "status": "corroborated",
        "deltas_generated": len(deltas_generated),
        "delta_ids": deltas_generated,
    }


def pending_feedback():
    """List all pending (un-corroborated) feedback entries."""
    entries = _load_feedback_entries()
    pending = [e for e in entries if e.get("status") == "pending"]
    return pending


def feedback_stats():
    """Get feedback quarantine statistics."""
    entries = _load_feedback_entries()
    by_status = {}
    for entry in entries:
        status = entry.get("status", "unknown")
        by_status[status] = by_status.get(status, 0) + 1

    return {
        "total_entries": len(entries),
        "by_status": by_status,
        "feedback_file": FEEDBACK_FILE,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "submit":
        if len(sys.argv) < 3:
            print("Usage: playbook-feedback-quarantine.py submit '<json>'", file=sys.stderr)
            sys.exit(1)
        fb_id, errors = submit_feedback(sys.argv[2])
        if errors:
            print(f"Feedback {fb_id} submitted with validation errors:")
            for e in errors:
                print(f"  - {e}")
        else:
            print(f"Feedback {fb_id} submitted to quarantine (pending corroboration)")

    elif cmd == "corroborate":
        if len(sys.argv) < 3:
            print("Usage: playbook-feedback-quarantine.py corroborate <id> --outcome '<json>'", file=sys.stderr)
            sys.exit(1)
        fb_id = sys.argv[2]
        outcome = "{}"
        if "--outcome" in sys.argv:
            idx = sys.argv.index("--outcome")
            outcome = sys.argv[idx + 1]
        result = corroborate_feedback(fb_id, outcome)
        print(json.dumps(result, indent=2))

    elif cmd == "pending":
        pending = pending_feedback()
        if not pending:
            print("No pending feedback entries.")
        else:
            for entry in pending:
                items = entry.get("items", [])
                print(f"  {entry.get('feedback_id', '?')} from {entry.get('source_agent', '?')} "
                      f"({len(items)} items, session {entry.get('parent_session', '?')})")
            print(f"\n{len(pending)} pending entries")

    elif cmd == "stats":
        stats = feedback_stats()
        print(json.dumps(stats, indent=2))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
