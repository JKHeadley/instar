#!/usr/bin/env python3
"""
Playbook Retirement Cycle — archive retired items, manage resurrection.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 4.8 Cycle 4).

Retirement pipeline:
  - Items below relevance threshold AND past grace period get status=retired
  - History entries preserved (immutable history principle)
  - Retired items archived to .claude/context-archive/{year-month}/
  - Resurrection: if retired item matches assembly query, resurrect with log

Usage:
    python3 playbook-retirement.py archive              # Archive retired items
    python3 playbook-retirement.py resurrect <item_id>   # Resurrect an item
    python3 playbook-retirement.py list-retired           # List retired items
    python3 playbook-retirement.py check-resurrection     # Check if any retired items should resurrect

Library usage:
    from playbook_retirement import archive_retired, resurrect_item
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
ARCHIVE_DIR = os.path.join(PROJECT_DIR, "context-archive")
HISTORY_FILE = _paths.history
RETIREMENT_LOG = os.path.join(PROJECT_DIR, "context-retirement-log.jsonl")


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _import_history():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_history",
        os.path.join(SCRIPT_DIR, "playbook-history.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def get_retired_items(manifest=None):
    """Get all items with status=retired from manifest."""
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return []
    return [i for i in manifest.get("items", []) if i.get("status") == "retired"]


def archive_retired(manifest=None, dry_run=True):
    """
    Archive all retired items to .claude/context-archive/{year-month}/.

    Retired items are removed from the active manifest and saved
    to archive files. History entries are NEVER deleted.
    """
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    retired = get_retired_items(manifest)
    if not retired:
        return {
            "status": "no_retired",
            "message": "No retired items to archive",
        }

    # Group by year-month
    year_month = time.strftime("%Y-%m", time.gmtime())
    archive_path = os.path.join(ARCHIVE_DIR, year_month)

    archived = []
    for item in retired:
        item_id = item.get("id", "")
        archive_entry = {
            "item": item,
            "archived_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "retired_at": item.get("retired_at", ""),
        }

        if not dry_run:
            os.makedirs(archive_path, exist_ok=True)
            # Safe filename from item ID
            safe_name = item_id.replace("/", "_").strip("_") + ".json"
            entry_path = os.path.join(archive_path, safe_name)
            atomic_write_json(entry_path, archive_entry)

        archived.append(item_id)

    # Remove archived items from manifest
    if not dry_run and archived:
        manifest["items"] = [i for i in manifest["items"]
                             if i.get("id") not in archived
                             or i.get("status") != "retired"]
        manifest["last_lifecycle_run"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write_json(MANIFEST_FILE, manifest)

    # Log
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "operation": "archive",
        "items_archived": len(archived),
        "archive_path": archive_path,
        "dry_run": dry_run,
        "item_ids": archived,
    }
    atomic_append(RETIREMENT_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "complete",
        "items_archived": len(archived),
        "archive_path": archive_path,
        "dry_run": dry_run,
        "archived_ids": archived,
    }


def resurrect_item(item_id, reason="", session_id="system"):
    """
    Resurrect a retired/archived item back to active status.

    Checks both manifest (for items still in manifest with retired status)
    and archive directory (for items that were fully archived).
    """
    manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    # Check manifest first
    for item in manifest.get("items", []):
        if item.get("id") == item_id and item.get("status") == "retired":
            item["status"] = "active"
            item["freshness"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            item.pop("retired_at", None)
            item.setdefault("provenance", []).append({
                "source_session": session_id,
                "created_at": time.strftime("%Y-%m-%d"),
                "provenance_type": "system-computed",
                "note": f"Resurrected: {reason}",
            })
            atomic_write_json(MANIFEST_FILE, manifest)

            # Log resurrection in history
            try:
                history = _import_history()
                history.append_entry(
                    "resurrect", item_id, session_id,
                    payload={"reason": reason})
            except Exception:
                pass

            log_entry = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "operation": "resurrect",
                "item_id": item_id,
                "reason": reason,
                "source": "manifest",
            }
            atomic_append(RETIREMENT_LOG, json.dumps(log_entry, separators=(",", ":")))

            return {
                "status": "resurrected",
                "item_id": item_id,
                "source": "manifest",
            }

    # Check archive
    if os.path.exists(ARCHIVE_DIR):
        for month_dir in os.listdir(ARCHIVE_DIR):
            month_path = os.path.join(ARCHIVE_DIR, month_dir)
            if not os.path.isdir(month_path):
                continue
            for fname in os.listdir(month_path):
                if not fname.endswith(".json"):
                    continue
                fpath = os.path.join(month_path, fname)
                try:
                    with open(fpath, "r") as f:
                        archive_entry = json.load(f)
                    archived_item = archive_entry.get("item", {})
                    if archived_item.get("id") == item_id:
                        # Resurrect from archive
                        archived_item["status"] = "active"
                        archived_item["freshness"] = time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                        archived_item.pop("retired_at", None)
                        archived_item.setdefault("provenance", []).append({
                            "source_session": session_id,
                            "created_at": time.strftime("%Y-%m-%d"),
                            "provenance_type": "system-computed",
                            "note": f"Resurrected from archive: {reason}",
                        })
                        manifest["items"].append(archived_item)
                        atomic_write_json(MANIFEST_FILE, manifest)

                        # Remove from archive
                        os.unlink(fpath)

                        # Log
                        try:
                            history = _import_history()
                            history.append_entry(
                                "resurrect", item_id, session_id,
                                payload={"reason": reason, "source": "archive"})
                        except Exception:
                            pass

                        log_entry = {
                            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                       time.gmtime()),
                            "operation": "resurrect",
                            "item_id": item_id,
                            "reason": reason,
                            "source": "archive",
                            "archive_path": fpath,
                        }
                        atomic_append(RETIREMENT_LOG,
                                      json.dumps(log_entry, separators=(",", ":")))

                        return {
                            "status": "resurrected",
                            "item_id": item_id,
                            "source": "archive",
                        }
                except (json.JSONDecodeError, KeyError):
                    continue

    return {
        "status": "not_found",
        "item_id": item_id,
        "message": "Item not found in manifest or archive",
    }


def check_resurrection_candidates(triggers=None, manifest=None):
    """
    Check if any retired/archived items match assembly triggers.

    If retired items match current work triggers, they should be resurrected.
    """
    if manifest is None:
        manifest = _load_manifest()
    if not manifest:
        return []

    if not triggers:
        return []

    triggers_lower = {t.lower() for t in triggers}
    candidates = []

    # Check retired items in manifest
    for item in manifest.get("items", []):
        if item.get("status") != "retired":
            continue
        tags = item.get("tags", {})
        item_domains = {d.lower() for d in tags.get("domains", [])}
        item_qualifiers = {q.lower() for q in tags.get("qualifiers", [])}
        item_triggers = {t.lower() for t in item.get("load_triggers", [])}

        overlap = (triggers_lower & item_domains) | (triggers_lower & item_qualifiers) | (triggers_lower & item_triggers)
        if overlap:
            candidates.append({
                "item_id": item["id"],
                "matching_triggers": list(overlap),
                "source": "manifest",
            })

    # Check archive
    if os.path.exists(ARCHIVE_DIR):
        for month_dir in sorted(os.listdir(ARCHIVE_DIR), reverse=True):
            month_path = os.path.join(ARCHIVE_DIR, month_dir)
            if not os.path.isdir(month_path):
                continue
            for fname in os.listdir(month_path):
                if not fname.endswith(".json"):
                    continue
                fpath = os.path.join(month_path, fname)
                try:
                    with open(fpath, "r") as f:
                        archive_entry = json.load(f)
                    item = archive_entry.get("item", {})
                    tags = item.get("tags", {})
                    item_domains = {d.lower() for d in tags.get("domains", [])}
                    item_qualifiers = {q.lower() for q in tags.get("qualifiers", [])}
                    item_triggers = {t.lower() for t in item.get("load_triggers", [])}
                    overlap = (triggers_lower & item_domains) | (triggers_lower & item_qualifiers) | (triggers_lower & item_triggers)
                    if overlap:
                        candidates.append({
                            "item_id": item.get("id", ""),
                            "matching_triggers": list(overlap),
                            "source": "archive",
                            "archive_path": fpath,
                        })
                except (json.JSONDecodeError, KeyError):
                    continue

    return candidates


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "archive":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        result = archive_retired(dry_run=dry_run)
        print(json.dumps(result, indent=2))

    elif cmd == "resurrect" and len(sys.argv) >= 3:
        item_id = sys.argv[2]
        reason = sys.argv[3] if len(sys.argv) > 3 else "manual resurrection"
        result = resurrect_item(item_id, reason)
        print(json.dumps(result, indent=2))

    elif cmd == "list-retired":
        retired = get_retired_items()
        if not retired:
            print("No retired items.")
        else:
            for item in retired:
                print(f"  {item['id']} (retired: {item.get('retired_at', '?')})")

    elif cmd == "check-resurrection":
        if len(sys.argv) >= 3:
            triggers = sys.argv[2:]
        else:
            triggers = []
        candidates = check_resurrection_candidates(triggers)
        if not candidates:
            print("No resurrection candidates.")
        else:
            for c in candidates:
                print(f"  {c['item_id']}: matches {c['matching_triggers']} (from {c['source']})")

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
