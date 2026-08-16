#!/usr/bin/env python3
"""
Playbook Token Re-estimation — recompute token counts on content hash change.

Part of Playbook Phase 3 (context-engineering-integration spec).

When a file backing a manifest item is modified (content_hash changes),
the token estimate becomes stale. This utility detects drift and updates.

Usage:
    python3 playbook-token-reestimate.py scan           # Check all items
    python3 playbook-token-reestimate.py update          # Update stale estimates

Library usage:
    from playbook_token_reestimate import scan_token_drift, recompute_tokens
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


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _resolve_path(path):
    """Resolve a manifest item path to an absolute path."""
    if os.path.isabs(path):
        return path if os.path.exists(path) else None
    abs_path = os.path.join(REPO_ROOT, path)
    if os.path.exists(abs_path):
        return abs_path
    abs_path = os.path.join(PROJECT_DIR, path)
    if os.path.exists(abs_path):
        return abs_path
    return None


def _compute_file_hash(abs_path):
    """Compute sha256:prefix hash matching manifest format."""
    with open(abs_path, "rb") as f:
        return "sha256:" + hashlib.sha256(f.read()).hexdigest()[:16]


def _estimate_tokens(abs_path):
    """Estimate token count from file content (chars / 4)."""
    with open(abs_path, "r", errors="replace") as f:
        content = f.read()
    return len(content) // 4 + 1


def _estimate_tokens_inline(content):
    """Estimate token count from inline content."""
    if not content:
        return 0
    return len(content) // 4 + 1


def scan_token_drift(manifest=None):
    """
    Scan all items for token estimate drift.

    Returns items where content_hash has changed (file modified)
    or where token estimate seems wrong.
    """
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    items = manifest.get("items", [])
    active_items = [i for i in items if i.get("status") == "active"]

    drifted = []
    up_to_date = []
    no_path = []

    for item in active_items:
        item_id = item.get("id", "")
        path = item.get("path", "")
        stored_hash = item.get("content_hash", "")
        stored_tokens = item.get("tokens_est", 0)

        if not path:
            # Inline-only items: check if tokens_est matches content_inline
            inline = item.get("content_inline", "")
            if inline:
                estimated = _estimate_tokens_inline(inline)
                if abs(estimated - stored_tokens) > 5:
                    drifted.append({
                        "item_id": item_id,
                        "type": "inline_drift",
                        "stored_tokens": stored_tokens,
                        "computed_tokens": estimated,
                    })
                else:
                    up_to_date.append(item_id)
            else:
                no_path.append(item_id)
            continue

        resolved = _resolve_path(path)
        if resolved is None:
            drifted.append({
                "item_id": item_id,
                "type": "file_missing",
                "path": path,
            })
            continue

        current_hash = _compute_file_hash(resolved)
        current_tokens = _estimate_tokens(resolved)

        if current_hash != stored_hash:
            drifted.append({
                "item_id": item_id,
                "type": "hash_drift",
                "path": path,
                "stored_hash": stored_hash,
                "current_hash": current_hash,
                "stored_tokens": stored_tokens,
                "computed_tokens": current_tokens,
            })
        elif abs(current_tokens - stored_tokens) > 10:
            drifted.append({
                "item_id": item_id,
                "type": "token_drift",
                "path": path,
                "stored_tokens": stored_tokens,
                "computed_tokens": current_tokens,
            })
        else:
            up_to_date.append(item_id)

    return {
        "status": "complete",
        "total_scanned": len(active_items),
        "drifted": len(drifted),
        "up_to_date": len(up_to_date),
        "no_path": len(no_path),
        "drift_details": drifted,
    }


def recompute_tokens(manifest=None, dry_run=True):
    """
    Recompute token estimates for all items with drift.

    Updates manifest in-place if dry_run=False.
    Returns list of items that were updated.
    """
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    scan = scan_token_drift(manifest)
    if scan.get("status") == "error":
        return scan

    drifted = scan.get("drift_details", [])
    if not drifted:
        return {
            "status": "no_drift",
            "message": "All token estimates are current",
        }

    updated = []
    items_by_id = {i["id"]: i for i in manifest.get("items", [])}

    for drift in drifted:
        item_id = drift["item_id"]
        if item_id not in items_by_id:
            continue
        item = items_by_id[item_id]

        if drift["type"] == "file_missing":
            continue  # Can't recompute for missing files

        new_tokens = drift.get("computed_tokens")
        new_hash = drift.get("current_hash")

        if new_tokens is not None:
            old_tokens = item.get("tokens_est", 0)
            if not dry_run:
                item["tokens_est"] = new_tokens
                if new_hash:
                    item["content_hash"] = new_hash
            updated.append({
                "item_id": item_id,
                "old_tokens": old_tokens,
                "new_tokens": new_tokens,
                "hash_updated": bool(new_hash),
            })

    if not dry_run and updated:
        from atomic_write import atomic_write_json
        manifest["last_lifecycle_run"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write_json(MANIFEST_FILE, manifest)

    return {
        "status": "complete",
        "items_updated": len(updated),
        "dry_run": dry_run,
        "updates": updated,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        result = scan_token_drift()
        print(json.dumps(result, indent=2))

    elif cmd == "update":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        result = recompute_tokens(dry_run=dry_run)
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
