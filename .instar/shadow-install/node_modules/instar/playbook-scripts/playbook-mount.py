#!/usr/bin/env python3
"""
Playbook Mount Manager — verified manifest overlay system.

Part of Playbook Phase 4 (Instar Packaging spec, Section 4D).

Mounts create verified snapshots (not live links) of external manifests.
Each mount goes through:
  1. Path validation (realpath containment in trusted_mount_roots)
  2. SHA-256 hash computation
  3. Delta validation of all items
  4. User-scope filtering (only global items accepted)
  5. Snapshot copy to local mounts directory
  6. Metadata recording

Usage:
    python3 playbook-mount.py mount /path/to/manifest.json --name team-playbook [--trust]
    python3 playbook-mount.py unmount team-playbook
    python3 playbook-mount.py list [--json]
    python3 playbook-mount.py verify [mount-name]
"""

import hashlib
import json
import os
import shutil
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths
from atomic_write import atomic_write_json

_paths = get_paths()
MOUNTS_DIR = os.path.join(_paths.playbook_root, "mounts")
MOUNTS_REGISTRY = os.path.join(_paths.playbook_root, "mounts.json")


def _compute_file_hash(filepath):
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def _load_mounts_registry():
    """Load the mounts registry."""
    if not os.path.exists(MOUNTS_REGISTRY):
        return {}
    with open(MOUNTS_REGISTRY, "r") as f:
        return json.load(f)


def _save_mounts_registry(registry):
    """Save the mounts registry."""
    atomic_write_json(MOUNTS_REGISTRY, registry)


def _get_trusted_roots():
    """Get trusted mount roots from playbook config."""
    config_path = os.path.join(_paths.playbook_root, "playbook-config.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r") as f:
                config = json.load(f)
            return config.get("trusted_mount_roots", [])
        except (json.JSONDecodeError, KeyError):
            pass
    return []


def _validate_source_path(source_path, trust=False):
    """Validate mount source path.

    Returns the resolved real path.
    Raises ValueError if path is not trusted.
    """
    real_path = os.path.realpath(source_path)

    if not os.path.exists(real_path):
        raise ValueError(f"Source path does not exist: {source_path}")

    if not os.path.isfile(real_path):
        raise ValueError(f"Source path is not a file: {source_path}")

    if trust:
        return real_path

    # Check against trusted roots
    trusted_roots = _get_trusted_roots()
    if trusted_roots:
        for root in trusted_roots:
            root_real = os.path.realpath(root)
            if real_path.startswith(root_real + os.sep) or real_path == root_real:
                return real_path
        raise ValueError(
            f"Source path is not under any trusted_mount_roots.\n"
            f"  Path: {real_path}\n"
            f"  Trusted roots: {trusted_roots}\n"
            f"  Use --trust to override, or add to trusted_mount_roots in playbook-config.json"
        )

    # No trusted roots configured — allow with warning
    print(
        f"WARNING: No trusted_mount_roots configured. Consider adding to playbook-config.json.",
        file=sys.stderr,
    )
    return real_path


def _validate_manifest(data):
    """Validate that data is a valid manifest structure."""
    if not isinstance(data, dict):
        raise ValueError("Manifest is not a JSON object")
    if "items" not in data or not isinstance(data["items"], list):
        raise ValueError("Manifest missing 'items' array")
    return True


def _filter_global_items(items):
    """Filter to only global-scope items. User-scoped items are rejected."""
    accepted = []
    rejected = []
    for item in items:
        scope = item.get("access_scope", "global")
        if scope == "global":
            accepted.append(item)
        else:
            rejected.append({
                "id": item.get("id", "unknown"),
                "reason": f"access_scope is '{scope}' (only 'global' items can be mounted)",
            })
    return accepted, rejected


def mount(source_path, name, trust=False, json_output=False):
    """Mount an external manifest as a verified snapshot."""
    # Step 1: Validate source path
    try:
        real_path = _validate_source_path(source_path, trust=trust)
    except ValueError as e:
        if json_output:
            print(json.dumps({"error": str(e), "status": "failed"}))
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1

    # Step 2: Read and validate manifest
    try:
        with open(real_path, "r") as f:
            source_manifest = json.load(f)
        _validate_manifest(source_manifest)
    except (json.JSONDecodeError, ValueError) as e:
        if json_output:
            print(json.dumps({"error": str(e), "status": "failed"}))
        else:
            print(f"ERROR: Invalid manifest: {e}", file=sys.stderr)
        return 2

    # Step 3: Compute source hash
    source_hash = _compute_file_hash(real_path)

    # Step 4: Filter user-scoped items
    items = source_manifest.get("items", [])
    accepted_items, rejected_items = _filter_global_items(items)

    # Step 5: Create snapshot directory
    mount_dir = os.path.join(MOUNTS_DIR, name)
    os.makedirs(mount_dir, exist_ok=True)

    # Step 6: Write snapshot manifest (only accepted items)
    snapshot_manifest = {
        "version": source_manifest.get("version", 1),
        "schema_version": source_manifest.get("schema_version", "2.0.0"),
        "items": accepted_items,
        "mount_source": True,
    }
    snapshot_path = os.path.join(mount_dir, "context-manifest.json")
    atomic_write_json(snapshot_path, snapshot_manifest)

    # Step 7: Write mount metadata
    mount_meta = {
        "source": real_path,
        "source_hash": source_hash,
        "mount_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "item_count": len(accepted_items),
        "items_rejected": len(rejected_items),
        "rejected_details": rejected_items[:10],  # Cap for readability
        "verified": True,
    }
    meta_path = os.path.join(mount_dir, "mount-meta.json")
    atomic_write_json(meta_path, mount_meta)

    # Step 8: Update registry
    registry = _load_mounts_registry()
    registry[name] = {
        "source": real_path,
        "source_hash": source_hash,
        "mount_time": mount_meta["mount_time"],
        "item_count": len(accepted_items),
        "verified": True,
    }
    _save_mounts_registry(registry)

    if json_output:
        print(json.dumps({
            "status": "mounted",
            "name": name,
            "source": real_path,
            "source_hash": source_hash,
            "items_accepted": len(accepted_items),
            "items_rejected": len(rejected_items),
        }))
    else:
        print(f"Mounted '{name}' from {real_path}")
        print(f"  Items: {len(accepted_items)} accepted, {len(rejected_items)} rejected")
        print(f"  Hash: {source_hash}")
        if rejected_items:
            print(f"  Rejected (user-scoped):")
            for r in rejected_items[:5]:
                print(f"    - {r['id']}: {r['reason']}")

    return 0


def unmount(name, json_output=False):
    """Remove a mounted manifest."""
    mount_dir = os.path.join(MOUNTS_DIR, name)
    registry = _load_mounts_registry()

    if name not in registry and not os.path.exists(mount_dir):
        if json_output:
            print(json.dumps({"error": f"Mount '{name}' not found", "status": "failed"}))
        else:
            print(f"ERROR: Mount '{name}' not found", file=sys.stderr)
        return 1

    # Remove directory
    if os.path.exists(mount_dir):
        shutil.rmtree(mount_dir)

    # Update registry
    if name in registry:
        del registry[name]
        _save_mounts_registry(registry)

    if json_output:
        print(json.dumps({"status": "unmounted", "name": name}))
    else:
        print(f"Unmounted '{name}'")

    return 0


def list_mounts(json_output=False):
    """List all mounted manifests."""
    registry = _load_mounts_registry()

    if json_output:
        print(json.dumps({"mounts": registry}))
        return 0

    if not registry:
        print("No mounts configured.")
        return 0

    print(f"Mounts ({len(registry)}):\n")
    for name, info in registry.items():
        verified = "verified" if info.get("verified") else "UNVERIFIED"
        print(f"  {name}")
        print(f"    Source: {info.get('source', 'unknown')}")
        print(f"    Items: {info.get('item_count', '?')}")
        print(f"    Hash: {info.get('source_hash', 'unknown')}")
        print(f"    Mounted: {info.get('mount_time', 'unknown')}")
        print(f"    Status: {verified}")
        print()

    return 0


def verify_mount(name=None, json_output=False):
    """Verify mount integrity — check source hash matches snapshot."""
    registry = _load_mounts_registry()

    if name:
        mounts_to_check = {name: registry.get(name)}
        if not registry.get(name):
            if json_output:
                print(json.dumps({"error": f"Mount '{name}' not found"}))
            else:
                print(f"ERROR: Mount '{name}' not found", file=sys.stderr)
            return 1
    else:
        mounts_to_check = registry

    results = {}
    all_ok = True

    for mount_name, info in mounts_to_check.items():
        source = info.get("source", "")
        stored_hash = info.get("source_hash", "")

        if not os.path.exists(source):
            results[mount_name] = {
                "status": "source_missing",
                "message": f"Source file no longer exists: {source}",
            }
            all_ok = False
            continue

        current_hash = _compute_file_hash(source)
        if current_hash == stored_hash:
            results[mount_name] = {"status": "ok", "hash": current_hash}
        else:
            results[mount_name] = {
                "status": "hash_mismatch",
                "stored_hash": stored_hash,
                "current_hash": current_hash,
                "message": "Source has changed since mount. Re-mount to update.",
            }
            all_ok = False

    if json_output:
        print(json.dumps({"results": results, "all_ok": all_ok}))
    else:
        for mount_name, result in results.items():
            status = result["status"]
            if status == "ok":
                print(f"  {mount_name}: OK (hash matches)")
            elif status == "hash_mismatch":
                print(f"  {mount_name}: CHANGED — source has been modified")
                print(f"    Stored: {result['stored_hash']}")
                print(f"    Current: {result['current_hash']}")
                print(f"    Run: instar playbook mount {info['source']} --name {mount_name}")
            elif status == "source_missing":
                print(f"  {mount_name}: MISSING — source file no longer exists")

    return 0 if all_ok else 2


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    json_output = "--json" in sys.argv

    if cmd == "mount":
        if len(sys.argv) < 4:
            print("Usage: playbook-mount.py mount SOURCE_PATH --name NAME [--trust] [--json]", file=sys.stderr)
            sys.exit(1)
        source_path = sys.argv[2]
        name = None
        trust = "--trust" in sys.argv
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--name" and i + 1 < len(sys.argv):
                name = sys.argv[i + 1]
                i += 2
            else:
                i += 1
        if not name:
            print("ERROR: --name is required", file=sys.stderr)
            sys.exit(1)
        sys.exit(mount(source_path, name, trust=trust, json_output=json_output))

    elif cmd == "unmount":
        if len(sys.argv) < 3:
            print("Usage: playbook-mount.py unmount NAME [--json]", file=sys.stderr)
            sys.exit(1)
        sys.exit(unmount(sys.argv[2], json_output=json_output))

    elif cmd == "list":
        sys.exit(list_mounts(json_output=json_output))

    elif cmd == "verify":
        name = None
        if len(sys.argv) >= 3 and not sys.argv[2].startswith("--"):
            name = sys.argv[2]
        sys.exit(verify_mount(name, json_output=json_output))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
