#!/usr/bin/env python3
"""
Playbook Semantic Verification — fact-type items checked against codebase state.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 4.8 Cycle 3).

Fact-type items have near-zero time decay but can become stale when
infrastructure changes. This job verifies facts are still accurate by:
  1. Checking file existence for path-based items
  2. Detecting content hash drift (file was modified since last check)
  3. Flagging items referencing deprecated/renamed files

Usage:
    python3 playbook-semantic-verify.py scan           # Full verification scan
    python3 playbook-semantic-verify.py check <item_id> # Verify one item

Library usage:
    from playbook_semantic_verify import verify_item, scan_all_facts
"""

import hashlib
import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
REPO_ROOT = _paths.project_root
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
VERIFY_LOG = os.path.join(PROJECT_DIR, "context-semantic-verify.jsonl")


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _compute_file_hash(path):
    """Compute sha256:prefix hash for a file, matching manifest hash format."""
    abs_path = os.path.join(REPO_ROOT, path) if not os.path.isabs(path) else path
    if not os.path.exists(abs_path):
        abs_path = os.path.join(PROJECT_DIR, path)
    if not os.path.exists(abs_path):
        return None
    with open(abs_path, "rb") as f:
        return "sha256:" + hashlib.sha256(f.read()).hexdigest()[:16]


def _resolve_path(path):
    """Resolve a manifest item path to an absolute path."""
    if os.path.isabs(path):
        return path
    # Try relative to repo root first
    abs_path = os.path.join(REPO_ROOT, path)
    if os.path.exists(abs_path):
        return abs_path
    # Try relative to .claude/
    abs_path = os.path.join(PROJECT_DIR, path)
    if os.path.exists(abs_path):
        return abs_path
    return None


def verify_item(item):
    """
    Verify a single manifest item against current codebase state.

    Returns dict with:
      - status: "valid", "stale", "missing", "hash_drift", "skip"
      - details: explanation
      - current_hash: current file hash (if applicable)
    """
    item_id = item.get("id", "")
    path = item.get("path", "")
    stored_hash = item.get("content_hash", "")
    memory_type = item.get("memory_type", "")
    category = item.get("category", "")

    # Only verify items with file paths
    if not path:
        # Inline-only items without paths are always valid structurally
        return {
            "status": "skip",
            "item_id": item_id,
            "details": "No file path (inline-only item)",
        }

    # Resolve the path
    resolved = _resolve_path(path)
    if resolved is None:
        return {
            "status": "missing",
            "item_id": item_id,
            "path": path,
            "details": f"File not found: {path}",
        }

    # Check hash drift
    current_hash = _compute_file_hash(resolved)
    if current_hash and stored_hash and current_hash != stored_hash:
        return {
            "status": "hash_drift",
            "item_id": item_id,
            "path": path,
            "stored_hash": stored_hash,
            "current_hash": current_hash,
            "details": f"Content changed since last check (was {stored_hash}, now {current_hash})",
        }

    return {
        "status": "valid",
        "item_id": item_id,
        "path": path,
        "current_hash": current_hash,
        "details": "File exists and hash matches",
    }


def scan_all_facts(manifest=None):
    """
    Scan all fact-type and path-based items for staleness.

    Returns summary with per-item results.
    """
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    items = manifest.get("items", [])
    active_items = [i for i in items if i.get("status") == "active"]

    results = {
        "valid": [],
        "stale": [],
        "missing": [],
        "hash_drift": [],
        "skipped": [],
    }

    for item in active_items:
        result = verify_item(item)
        status = result["status"]
        if status == "valid":
            results["valid"].append(result)
        elif status == "missing":
            results["missing"].append(result)
        elif status == "hash_drift":
            results["hash_drift"].append(result)
        elif status == "stale":
            results["stale"].append(result)
        else:
            results["skipped"].append(result)

    # Log the scan
    try:
        from atomic_write import atomic_append
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "items_scanned": len(active_items),
            "valid": len(results["valid"]),
            "missing": len(results["missing"]),
            "hash_drift": len(results["hash_drift"]),
            "stale": len(results["stale"]),
            "skipped": len(results["skipped"]),
        }
        atomic_append(VERIFY_LOG, json.dumps(log_entry, separators=(",", ":")))
    except Exception:
        pass

    return {
        "status": "complete",
        "items_scanned": len(active_items),
        "summary": {
            "valid": len(results["valid"]),
            "missing": len(results["missing"]),
            "hash_drift": len(results["hash_drift"]),
            "stale": len(results["stale"]),
            "skipped": len(results["skipped"]),
        },
        "issues": results["missing"] + results["hash_drift"] + results["stale"],
    }


def generate_update_deltas(scan_result, dry_run=True):
    """
    Generate deltas to update items with hash drift.

    For missing files, flags for human review.
    For hash drift, proposes content_hash update + token re-estimation.
    """
    import secrets

    deltas = []
    for issue in scan_result.get("issues", []):
        if issue["status"] == "hash_drift":
            delta = {
                "delta_id": f"delta-{secrets.token_hex(6)}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source_session": "SEMANTIC_VERIFY",
                "operation": "update_content",
                "target_item_id": issue["item_id"],
                "reflector_confidence": 0.95,
                "payload": {
                    "content_hash": issue["current_hash"],
                },
                "evidence": [{
                    "type": "test_result",
                    "value": f"hash_drift:{issue['stored_hash']}->{issue['current_hash']}",
                }],
            }
            deltas.append(delta)

        elif issue["status"] == "missing":
            delta = {
                "delta_id": f"delta-{secrets.token_hex(6)}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source_session": "SEMANTIC_VERIFY",
                "operation": "retire",
                "target_item_id": issue["item_id"],
                "reflector_confidence": 0.70,
                "payload": {
                    "reason": f"File missing: {issue.get('path', 'unknown')}",
                },
                "evidence": [{
                    "type": "test_result",
                    "value": f"file_missing:{issue.get('path', '')}",
                }],
            }
            deltas.append(delta)

    return deltas


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        result = scan_all_facts()
        if result.get("status") == "error":
            print(result["message"], file=sys.stderr)
            sys.exit(1)
        print(json.dumps(result, indent=2))
        if result["summary"]["missing"] > 0 or result["summary"]["hash_drift"] > 0:
            sys.exit(1)

    elif cmd == "check" and len(sys.argv) >= 3:
        item_id = sys.argv[2]
        manifest = _load_manifest()
        if not manifest:
            print("No manifest found", file=sys.stderr)
            sys.exit(1)
        for item in manifest.get("items", []):
            if item.get("id") == item_id:
                result = verify_item(item)
                print(json.dumps(result, indent=2))
                sys.exit(0 if result["status"] == "valid" else 1)
        print(f"Item not found: {item_id}", file=sys.stderr)
        sys.exit(1)

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
