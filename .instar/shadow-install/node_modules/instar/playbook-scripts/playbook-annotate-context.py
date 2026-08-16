#!/usr/bin/env python3
"""
Playbook Human Annotation Path — human-verified context item operations.

Part of Playbook Phase 2 (context-engineering-integration spec, Section 4.4).

Provides a CLI for humans to:
  - Annotate items as human-verified (elevates provenance)
  - Approve pending-review deltas
  - Reject pending-review deltas
  - Resolve quarantined items

All operations create deltas with provenance_type: human-verified,
which carries elevated authority in the lifecycle pipeline.

Usage:
    python3 playbook-annotate-context.py verify <item_id>     # Mark as human-verified
    python3 playbook-annotate-context.py approve <delta_id>   # Approve pending delta
    python3 playbook-annotate-context.py reject <delta_id>    # Reject pending delta
    python3 playbook-annotate-context.py list-pending          # List pending reviews
    python3 playbook-annotate-context.py resolve <item_id>     # Resolve quarantined item
"""

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_write_json, atomic_append
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest
PENDING_REVIEW_DIR = _paths.pending_review_dir
DELTAS_FILE = os.path.join(PROJECT_DIR, "context-deltas.jsonl")


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def verify_item(item_id):
    """Mark a manifest item as human-verified."""
    manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    for item in manifest.get("items", []):
        if item.get("id") == item_id:
            # Submit a delta to update provenance
            import secrets
            delta = {
                "delta_id": f"delta-{secrets.token_hex(6)}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source_session": "HUMAN",
                "operation": "update_content",
                "target_item_id": item_id,
                "reflector_confidence": 1.0,  # Human verification = max confidence
                "payload": {
                    "provenance_type": "human-verified",
                },
                "evidence": [{
                    "type": "human_verification",
                    "value": "true",
                }],
            }
            atomic_append(DELTAS_FILE, json.dumps(delta, separators=(",", ":")))
            return {
                "status": "verified",
                "item_id": item_id,
                "delta_id": delta["delta_id"],
            }

    return {"status": "error", "message": f"Item not found: {item_id}"}


def approve_pending(delta_id):
    """Approve a pending-review delta and submit it to the pipeline."""
    review_path = os.path.join(PENDING_REVIEW_DIR, f"{delta_id}.json")
    if not os.path.exists(review_path):
        return {"status": "error", "message": f"Pending review not found: {delta_id}"}

    with open(review_path, "r") as f:
        review = json.load(f)

    # Re-submit the delta with elevated confidence (human-approved)
    delta = review.get("delta", {})
    delta["reflector_confidence"] = 1.0  # Human approval = max confidence
    if "evidence" not in delta:
        delta["evidence"] = []
    delta["evidence"].append({
        "type": "human_verification",
        "value": "approved",
    })

    # Give it a new delta_id to avoid idempotency filter
    import secrets
    delta["delta_id"] = f"delta-{secrets.token_hex(6)}"
    delta["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    atomic_append(DELTAS_FILE, json.dumps(delta, separators=(",", ":")))

    # Mark the review as approved
    review["status"] = "approved"
    review["approved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    review["approved_delta_id"] = delta["delta_id"]
    atomic_write_json(review_path, review)

    return {
        "status": "approved",
        "original_delta_id": delta_id,
        "new_delta_id": delta["delta_id"],
    }


def reject_pending(delta_id, reason="rejected by human"):
    """Reject a pending-review delta."""
    review_path = os.path.join(PENDING_REVIEW_DIR, f"{delta_id}.json")
    if not os.path.exists(review_path):
        return {"status": "error", "message": f"Pending review not found: {delta_id}"}

    with open(review_path, "r") as f:
        review = json.load(f)

    review["status"] = "rejected"
    review["rejected_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    review["rejection_reason"] = reason
    atomic_write_json(review_path, review)

    return {"status": "rejected", "delta_id": delta_id, "reason": reason}


def list_pending():
    """List all pending review items."""
    if not os.path.exists(PENDING_REVIEW_DIR):
        return []

    pending = []
    for filename in sorted(os.listdir(PENDING_REVIEW_DIR)):
        if not filename.endswith(".json"):
            continue
        filepath = os.path.join(PENDING_REVIEW_DIR, filename)
        with open(filepath, "r") as f:
            review = json.load(f)
        if review.get("status") == "pending":
            delta = review.get("delta", {})
            pending.append({
                "delta_id": review.get("delta_id"),
                "operation": delta.get("operation"),
                "target": delta.get("target_item_id"),
                "confidence": delta.get("reflector_confidence"),
                "review_reason": review.get("review_reason", {}),
                "submitted_at": review.get("submitted_at"),
            })
    return pending


def resolve_quarantine(item_id):
    """Resolve a quarantined item by submitting a human-verified delta."""
    manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    for item in manifest.get("items", []):
        if item.get("id") == item_id and item.get("status") == "quarantine":
            import secrets
            delta = {
                "delta_id": f"delta-{secrets.token_hex(6)}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source_session": "HUMAN",
                "operation": "resolve_quarantine",
                "target_item_id": item_id,
                "reflector_confidence": 1.0,
                "payload": {
                    "status": "active",
                },
                "evidence": [{
                    "type": "human_verification",
                    "value": "quarantine_resolved",
                }],
            }
            atomic_append(DELTAS_FILE, json.dumps(delta, separators=(",", ":")))
            return {
                "status": "resolved",
                "item_id": item_id,
                "delta_id": delta["delta_id"],
            }

    return {"status": "error", "message": f"Item not quarantined or not found: {item_id}"}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "verify" and len(sys.argv) >= 3:
        result = verify_item(sys.argv[2])
        print(json.dumps(result, indent=2))

    elif cmd == "approve" and len(sys.argv) >= 3:
        result = approve_pending(sys.argv[2])
        print(json.dumps(result, indent=2))

    elif cmd == "reject" and len(sys.argv) >= 3:
        reason = sys.argv[3] if len(sys.argv) >= 4 else "rejected by human"
        result = reject_pending(sys.argv[2], reason)
        print(json.dumps(result, indent=2))

    elif cmd == "list-pending":
        pending = list_pending()
        if not pending:
            print("No pending reviews.")
        else:
            for p in pending:
                print(f"  {p['delta_id']} [{p['operation']}] -> {p['target']} "
                      f"(confidence: {p['confidence']})")
            print(f"\n{len(pending)} pending review(s)")

    elif cmd == "resolve" and len(sys.argv) >= 3:
        result = resolve_quarantine(sys.argv[2])
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
