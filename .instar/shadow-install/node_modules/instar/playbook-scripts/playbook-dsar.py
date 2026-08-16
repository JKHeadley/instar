#!/usr/bin/env python3
"""
Playbook DSAR (Data Subject Access Request) — GDPR/CCPA compliance commands.

Part of Playbook Phase 4 (Instar Packaging spec, Section 4C + 4E.3).

Provides data subject rights:
  - user-export: Export all data for a user
  - user-delete: Delete all user data (with confirmation)
  - user-audit: Audit trail of all operations on user data

User identity is determined by user_identity_source in playbook-config.json:
  - "config" (default): --user flag required
  - "env": reads PLAYBOOK_USER_ID
  - "instar": uses Instar's user system

Usage:
    python3 playbook-dsar.py user-export USER_ID [--json]
    python3 playbook-dsar.py user-delete USER_ID --confirm [--json]
    python3 playbook-dsar.py user-audit USER_ID [--json]
"""

import json
import os
import shutil
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths
from playbook_backend import get_backend
from atomic_write import atomic_write_json

_paths = get_paths()


def _collect_user_items(manifest, user_id):
    """Find all manifest items belonging to a user."""
    items = manifest.get("items", [])
    return [item for item in items if item.get("user_id") == user_id]


def _collect_user_history(user_id):
    """Find all history entries related to a user."""
    backend = get_backend()
    history = backend.read_history()
    return [
        entry for entry in history
        if entry.get("user_id") == user_id
        or entry.get("payload", {}).get("user_id") == user_id
    ]


def _collect_user_scratchpads(user_id):
    """Find session scratchpads containing user data."""
    sessions_dir = os.path.join(_paths.playbook_root, "sessions")
    if not os.path.exists(sessions_dir):
        return []

    results = []
    for session_id in os.listdir(sessions_dir):
        scratchpad_path = os.path.join(sessions_dir, session_id, "scratchpad.json")
        if not os.path.exists(scratchpad_path):
            continue
        try:
            with open(scratchpad_path, "r") as f:
                data = json.load(f)
            # Check if scratchpad references this user
            if data.get("user_id") == user_id:
                results.append({
                    "session_id": session_id,
                    "created_at": data.get("created_at"),
                    "strategies": len(data.get("strategies_discovered", [])),
                    "failures": len(data.get("failure_patterns", [])),
                })
        except (json.JSONDecodeError, KeyError):
            continue

    return results


def _get_user_namespace_dir(user_id):
    """Get path to user namespace directory."""
    return os.path.join(_paths.playbook_root, "users", user_id)


def user_export(user_id, json_output=False):
    """Export all data for a user."""
    backend = get_backend()
    manifest = backend.read_manifest()

    # Collect from all sources
    user_items = _collect_user_items(manifest, user_id)
    user_history = _collect_user_history(user_id)
    user_scratchpads = _collect_user_scratchpads(user_id)

    # Check user namespace
    user_dir = _get_user_namespace_dir(user_id)
    user_manifest = None
    user_namespace_history = []
    if os.path.exists(user_dir):
        user_manifest_path = os.path.join(user_dir, "context-manifest.json")
        if os.path.exists(user_manifest_path):
            with open(user_manifest_path, "r") as f:
                user_manifest = json.load(f)
        user_history_path = os.path.join(user_dir, "context-history.jsonl")
        if os.path.exists(user_history_path):
            with open(user_history_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            user_namespace_history.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue

    export_data = {
        "user_id": user_id,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "global_manifest_items": user_items,
        "global_manifest_item_count": len(user_items),
        "history_entries": user_history,
        "history_entry_count": len(user_history),
        "scratchpads": user_scratchpads,
        "scratchpad_count": len(user_scratchpads),
        "user_namespace": {
            "exists": os.path.exists(user_dir),
            "manifest": user_manifest,
            "history": user_namespace_history,
        },
    }

    if json_output:
        print(json.dumps(export_data, indent=2, ensure_ascii=True))
    else:
        print(f"User Data Export: {user_id}")
        print(f"  Exported at: {export_data['exported_at']}")
        print(f"  Global items: {len(user_items)}")
        for item in user_items:
            print(f"    - {item.get('id', 'unknown')} ({item.get('category', '?')})")
        print(f"  History entries: {len(user_history)}")
        print(f"  Scratchpads: {len(user_scratchpads)}")
        if os.path.exists(user_dir):
            ns_items = len((user_manifest or {}).get("items", []))
            print(f"  User namespace: {ns_items} items, {len(user_namespace_history)} history entries")
        else:
            print(f"  User namespace: not created")
        print()
        print("Use --json for full data export.")

    return 0


def user_delete(user_id, confirm=False, json_output=False):
    """Delete all data for a user."""
    if not confirm:
        print("ERROR: This permanently deletes all data for this user.", file=sys.stderr)
        print("  Add --confirm to proceed.", file=sys.stderr)
        return 1

    backend = get_backend()
    deleted = {
        "user_id": user_id,
        "deleted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "global_items_removed": 0,
        "scratchpads_removed": 0,
        "namespace_removed": False,
    }

    # Step 1: Remove items from global manifest
    with backend.lock():
        manifest = backend.read_manifest()
        original_count = len(manifest.get("items", []))
        manifest["items"] = [
            item for item in manifest.get("items", [])
            if item.get("user_id") != user_id
        ]
        deleted["global_items_removed"] = original_count - len(manifest["items"])
        backend.write_manifest(manifest)

    # Step 2: Remove user namespace
    user_dir = _get_user_namespace_dir(user_id)
    if os.path.exists(user_dir):
        shutil.rmtree(user_dir)
        deleted["namespace_removed"] = True

    # Step 3: Clean session scratchpads
    sessions_dir = os.path.join(_paths.playbook_root, "sessions")
    if os.path.exists(sessions_dir):
        for session_id in os.listdir(sessions_dir):
            scratchpad_path = os.path.join(sessions_dir, session_id, "scratchpad.json")
            if not os.path.exists(scratchpad_path):
                continue
            try:
                with open(scratchpad_path, "r") as f:
                    data = json.load(f)
                if data.get("user_id") == user_id:
                    os.remove(scratchpad_path)
                    deleted["scratchpads_removed"] += 1
            except (json.JSONDecodeError, KeyError):
                continue

    # Step 4: Log the deletion in history
    backend.append_history({
        "type": "dsar_delete",
        "user_id": user_id,
        "timestamp": deleted["deleted_at"],
        "items_removed": deleted["global_items_removed"],
        "namespace_removed": deleted["namespace_removed"],
        "scratchpads_removed": deleted["scratchpads_removed"],
    })

    if json_output:
        print(json.dumps(deleted, indent=2))
    else:
        print(f"Deleted all data for user: {user_id}")
        print(f"  Global items removed: {deleted['global_items_removed']}")
        print(f"  Namespace removed: {deleted['namespace_removed']}")
        print(f"  Scratchpads removed: {deleted['scratchpads_removed']}")
        print(f"  Deletion logged in history.")

    return 0


def user_audit(user_id, json_output=False):
    """Audit trail of all operations on user data."""
    user_history = _collect_user_history(user_id)

    if json_output:
        print(json.dumps({
            "user_id": user_id,
            "audit_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "entries": user_history,
            "entry_count": len(user_history),
        }, indent=2))
    else:
        print(f"Audit Trail: {user_id}")
        print(f"  Entries: {len(user_history)}")
        print()
        if not user_history:
            print("  No history entries found.")
        else:
            for entry in user_history[-50:]:  # Last 50
                ts = entry.get("timestamp", "unknown")
                op = entry.get("type", entry.get("operation", "unknown"))
                item_id = entry.get("delta_id", entry.get("item_id", ""))
                print(f"  {ts}  {op}  {item_id}")
        print()

    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    json_output = "--json" in sys.argv

    if cmd == "user-export":
        if len(sys.argv) < 3:
            print("Usage: playbook-dsar.py user-export USER_ID [--json]", file=sys.stderr)
            sys.exit(1)
        user_id = sys.argv[2]
        sys.exit(user_export(user_id, json_output=json_output))

    elif cmd == "user-delete":
        if len(sys.argv) < 3:
            print("Usage: playbook-dsar.py user-delete USER_ID --confirm [--json]", file=sys.stderr)
            sys.exit(1)
        user_id = sys.argv[2]
        confirm = "--confirm" in sys.argv
        sys.exit(user_delete(user_id, confirm=confirm, json_output=json_output))

    elif cmd == "user-audit":
        if len(sys.argv) < 3:
            print("Usage: playbook-dsar.py user-audit USER_ID [--json]", file=sys.stderr)
            sys.exit(1)
        user_id = sys.argv[2]
        sys.exit(user_audit(user_id, json_output=json_output))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
