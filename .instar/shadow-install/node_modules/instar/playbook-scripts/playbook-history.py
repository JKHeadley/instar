#!/usr/bin/env python3
"""
Playbook Context History — HMAC-chained append-only log.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.1).

The immutable ground truth. Every context mutation is recorded here with
HMAC-chained integrity. Tampering with any entry invalidates all subsequent
entries. The manifest can always be reconstructed from this history.

Entry format (JSONL):
    {"seq": N, "timestamp": "ISO8601", "operation": "create|update_counter|update_content|retire|merge|resurrect|promote",
     "item_id": "/context/...", "payload": {...}, "source_session": "AUT-XXXX-wo",
     "prev_hmac": "hex...", "entry_hmac": "hex..."}

Usage:
    python3 playbook-history.py append <operation> <item_id> <source_session> [--payload '{}']
    python3 playbook-history.py verify [--from-seq N]
    python3 playbook-history.py tail [N]
    python3 playbook-history.py count
    python3 playbook-history.py get-seq <N>
    python3 playbook-history.py last-hmac
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
HISTORY_FILE = _paths.history
GENESIS_HMAC = "0" * 64

VALID_OPERATIONS = [
    "create", "update_counter", "update_content",
    "retire", "merge", "resurrect", "promote",
    "key_compromise_recovery", "genesis",
]


def _canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _get_hmac_module():
    """Import playbook-hmac functions."""
    hmac_script = os.path.join(SCRIPT_DIR, "playbook-hmac.py")
    import importlib.util
    spec = importlib.util.spec_from_file_location("playbook_hmac", hmac_script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _compute_entry_hmac(entry_dict, prev_hmac):
    """Compute HMAC for a history entry chained to previous."""
    hmac_mod = _get_hmac_module()
    entry_copy = {k: v for k, v in entry_dict.items() if k != "entry_hmac"}
    canonical = _canonical_json(entry_copy)
    return hmac_mod.chain_sign(canonical, prev_hmac)


def get_last_entry():
    """Get the last entry in the history file."""
    if not os.path.exists(HISTORY_FILE):
        return None
    last_line = None
    with open(HISTORY_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                last_line = line
    if last_line:
        return json.loads(last_line)
    return None


def get_last_hmac():
    """Get the HMAC of the last entry, or genesis HMAC if empty."""
    entry = get_last_entry()
    if entry:
        return entry.get("entry_hmac", GENESIS_HMAC)
    return GENESIS_HMAC


def get_last_seq():
    """Get the sequence number of the last entry, or 0 if empty."""
    entry = get_last_entry()
    if entry:
        return entry.get("seq", 0)
    return 0


def append_entry(operation, item_id, source_session, payload=None):
    """Append a new HMAC-chained entry to the history."""
    if operation not in VALID_OPERATIONS:
        raise ValueError(f"Invalid operation: {operation}. Must be one of: {VALID_OPERATIONS}")

    prev_hmac = get_last_hmac()
    seq = get_last_seq() + 1

    entry = {
        "seq": seq,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "operation": operation,
        "item_id": item_id,
        "source_session": source_session,
        "prev_hmac": prev_hmac,
    }

    if payload:
        entry["payload"] = payload

    entry_hmac = _compute_entry_hmac(entry, prev_hmac)
    entry["entry_hmac"] = entry_hmac

    line = json.dumps(entry, separators=(",", ":"), ensure_ascii=True)
    atomic_append(HISTORY_FILE, line)

    return entry


def verify_chain(from_seq=1):
    """Verify the HMAC chain integrity from a given sequence number."""
    if not os.path.exists(HISTORY_FILE):
        return {"valid": True, "entries": 0, "message": "No history file (empty)"}

    hmac_mod = _get_hmac_module()
    prev_hmac = GENESIS_HMAC
    count = 0
    errors = []

    with open(HISTORY_FILE, "r") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue

            try:
                entry = json.loads(line)
            except json.JSONDecodeError as e:
                errors.append({"line": line_num, "error": f"Invalid JSON: {e}"})
                break

            seq = entry.get("seq", 0)
            if seq < from_seq:
                prev_hmac = entry.get("entry_hmac", GENESIS_HMAC)
                continue

            count += 1
            stored_hmac = entry.get("entry_hmac", "")
            stored_prev = entry.get("prev_hmac", "")

            if stored_prev != prev_hmac:
                errors.append({
                    "seq": seq,
                    "error": "prev_hmac mismatch",
                    "expected": prev_hmac,
                    "got": stored_prev,
                })
                break

            entry_copy = {k: v for k, v in entry.items() if k != "entry_hmac"}
            canonical = _canonical_json(entry_copy)
            expected_hmac = hmac_mod.chain_sign(canonical, prev_hmac)

            if expected_hmac != stored_hmac:
                errors.append({
                    "seq": seq,
                    "error": "entry_hmac verification failed",
                    "expected": expected_hmac,
                    "got": stored_hmac,
                })
                break

            prev_hmac = stored_hmac

    if errors:
        return {"valid": False, "entries_verified": count, "errors": errors}
    return {"valid": True, "entries_verified": count, "message": "Chain integrity verified"}


def tail_entries(n=10):
    """Get the last N entries from the history."""
    if not os.path.exists(HISTORY_FILE):
        return []

    entries = []
    with open(HISTORY_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    return entries[-n:]


def get_entry_by_seq(seq):
    """Get a specific entry by sequence number."""
    if not os.path.exists(HISTORY_FILE):
        return None

    with open(HISTORY_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                entry = json.loads(line)
                if entry.get("seq") == seq:
                    return entry
    return None


def count_entries():
    """Count total entries in the history."""
    if not os.path.exists(HISTORY_FILE):
        return 0

    count = 0
    with open(HISTORY_FILE, "r") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "append":
        if len(sys.argv) < 5:
            print("Usage: playbook-history.py append <operation> <item_id> <source_session> [--payload '{}']", file=sys.stderr)
            sys.exit(1)
        operation = sys.argv[2]
        item_id = sys.argv[3]
        source_session = sys.argv[4]
        payload = None
        if "--payload" in sys.argv:
            idx = sys.argv.index("--payload")
            if idx + 1 < len(sys.argv):
                payload = json.loads(sys.argv[idx + 1])
        entry = append_entry(operation, item_id, source_session, payload)
        print(json.dumps(entry, indent=2))

    elif cmd == "verify":
        from_seq = 1
        if "--from-seq" in sys.argv:
            idx = sys.argv.index("--from-seq")
            if idx + 1 < len(sys.argv):
                from_seq = int(sys.argv[idx + 1])
        result = verify_chain(from_seq)
        print(json.dumps(result, indent=2))
        if not result["valid"]:
            sys.exit(1)

    elif cmd == "tail":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        for entry in tail_entries(n):
            print(json.dumps(entry))

    elif cmd == "count":
        print(count_entries())

    elif cmd == "get-seq":
        if len(sys.argv) < 3:
            print("Usage: playbook-history.py get-seq <N>", file=sys.stderr)
            sys.exit(1)
        entry = get_entry_by_seq(int(sys.argv[2]))
        if entry:
            print(json.dumps(entry, indent=2))
        else:
            print("Not found", file=sys.stderr)
            sys.exit(1)

    elif cmd == "last-hmac":
        print(get_last_hmac())

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
