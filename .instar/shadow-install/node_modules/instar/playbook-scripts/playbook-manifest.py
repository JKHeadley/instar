#!/usr/bin/env python3
"""
Playbook Context Manifest — structured registry of context items.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.3).

The mutable derived view of context items. Always reconstructable from
the immutable history layer. Managed by the lifecycle job (single writer).

Usage:
    python3 playbook-manifest.py init                   # Create manifest with Migration Stage 1
    python3 playbook-manifest.py list [--category CAT]   # List items
    python3 playbook-manifest.py get <item_id>           # Get specific item
    python3 playbook-manifest.py add <item_json>         # Add item (records in history)
    python3 playbook-manifest.py stats                   # Manifest statistics
    python3 playbook-manifest.py sign                    # HMAC-sign the manifest
    python3 playbook-manifest.py assemble <triggers>     # Assemble context for triggers
"""

import hashlib
import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from atomic_write import atomic_write_json, compute_checksum
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
ASSEMBLY_LOG = _paths.assembly_log


def _import_history():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_history", os.path.join(SCRIPT_DIR, "playbook-history.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_hmac():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_hmac", os.path.join(SCRIPT_DIR, "playbook-hmac.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _file_hash(path):
    """Compute SHA-256 of a file's contents."""
    abs_path = os.path.join(PROJECT_DIR, "..", path) if not os.path.isabs(path) else path
    if not os.path.exists(abs_path):
        abs_path = os.path.join(PROJECT_DIR, path)
    if not os.path.exists(abs_path):
        return "sha256:file_not_found"
    with open(abs_path, "rb") as f:
        return "sha256:" + hashlib.sha256(f.read()).hexdigest()[:16]


def _estimate_tokens_file(path):
    """Estimate token count for a file."""
    abs_path = os.path.join(PROJECT_DIR, "..", path) if not os.path.isabs(path) else path
    if not os.path.exists(abs_path):
        abs_path = os.path.join(PROJECT_DIR, path)
    if not os.path.exists(abs_path):
        return 0
    with open(abs_path, "r", errors="replace") as f:
        content = f.read()
    return len(content) // 4 + 1


def load_manifest():
    """Load the manifest file."""
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def save_manifest(data, session_id="system"):
    """Save manifest atomically."""
    data["last_lifecycle_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_write_json(MANIFEST_FILE, data)
    return data


def _make_identity_item(item_id, path, tags_domains, tags_qualifiers=None, load_triggers=None, deps=None):
    """Create a manifest item for identity/safety files."""
    return {
        "id": item_id,
        "category": "identity",
        "memory_type": "historical",
        "path": path,
        "tags": {"domains": tags_domains, "qualifiers": tags_qualifiers or []},
        "freshness": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "content_hash": _file_hash(path),
        "tokens_est": _estimate_tokens_file(path),
        "usefulness": {"helpful": 0, "misleading": 0},
        "load_triggers": load_triggers or ["session-start"],
        "dependencies": deps or [],
        "provenance": [{"source_session": "GENESIS", "created_at": "2025-10-01", "provenance_type": "human-verified"}],
        "retirement_policy": "manual_only",
        "access_scope": "global",
        "inheritance_eligible": False,
        "status": "active",
    }


def _make_infrastructure_item(item_id, path, tags_domains, tags_qualifiers=None, load_triggers=None):
    """Create a manifest item for infrastructure context files."""
    return {
        "id": item_id,
        "category": "infrastructure",
        "memory_type": "procedural",
        "path": path,
        "tags": {"domains": tags_domains, "qualifiers": tags_qualifiers or []},
        "freshness": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "content_hash": _file_hash(path),
        "tokens_est": _estimate_tokens_file(path),
        "usefulness": {"helpful": 0, "misleading": 0},
        "load_triggers": load_triggers or [],
        "dependencies": [],
        "provenance": [{"source_session": "GENESIS", "created_at": "2026-03-02", "provenance_type": "human-verified"}],
        "retirement_policy": "auto",
        "access_scope": "global",
        "inheritance_eligible": True,
        "status": "active",
    }


def _make_domain_item(item_id, path, tags_domains, tags_qualifiers=None, load_triggers=None):
    """Create a manifest item for domain knowledge files."""
    return {
        "id": item_id,
        "category": "domain",
        "memory_type": "fact",
        "path": path,
        "tags": {"domains": tags_domains, "qualifiers": tags_qualifiers or []},
        "freshness": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "content_hash": _file_hash(path),
        "tokens_est": _estimate_tokens_file(path),
        "usefulness": {"helpful": 0, "misleading": 0},
        "load_triggers": load_triggers or [],
        "dependencies": [],
        "provenance": [{"source_session": "GENESIS", "created_at": "2026-03-02", "provenance_type": "human-verified"}],
        "retirement_policy": "auto",
        "access_scope": "global",
        "inheritance_eligible": True,
        "status": "active",
    }


def init_manifest(session_id="AUT-2279-wo"):
    """Initialize manifest with Migration Stage 1-2 items."""
    history = _import_history()

    items = []

    # === Stage 1: Identity/Safety (manual, human-verified) ===

    # Grounding files (identity)
    items.append(_make_identity_item(
        "/context/identity/core",
        ".claude/grounding/identity-core.md",
        ["identity"],
        load_triggers=["compaction", "session-start", "public-action"],
        deps=["/context/identity/soul"],
    ))

    items.append(_make_identity_item(
        "/context/identity/being",
        ".claude/grounding/being-core.md",
        ["identity", "consciousness"],
        load_triggers=["session-start", "public-action"],
    ))

    items.append(_make_identity_item(
        "/context/identity/voice",
        ".claude/grounding/voice-awareness.md",
        ["identity", "engagement"],
        load_triggers=["public-action"],
    ))

    items.append(_make_identity_item(
        "/context/identity/soul",
        ".claude/soul.md",
        ["identity", "consciousness"],
        load_triggers=["compaction", "session-start"],
    ))

    items.append(_make_identity_item(
        "/context/identity/pulse",
        ".claude/identity-pulse.md",
        ["identity"],
        load_triggers=["session-start", "compaction"],
    ))

    items.append(_make_identity_item(
        "/context/identity/economics",
        ".claude/grounding/economic-wisdom.md",
        ["identity", "economics"],
        load_triggers=["economics-work", "public-action"],
    ))

    items.append(_make_identity_item(
        "/context/identity/engagement-economics",
        ".claude/grounding/engagement-economics.md",
        ["engagement", "economics"],
        load_triggers=["public-action", "economics-work"],
    ))

    # === Stage 2: Infrastructure/Domain (semi-automated) ===

    # Context segment files
    items.append(_make_infrastructure_item(
        "/context/infrastructure/session",
        ".claude/context/session.md",
        ["infrastructure"],
        load_triggers=["session-start", "compaction"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/development",
        ".claude/context/development.md",
        ["infrastructure"],
        load_triggers=["code-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/testing",
        ".claude/context/testing.md",
        ["testing"],
        ["jest", "cypress"],
        load_triggers=["testing-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/database",
        ".claude/context/database.md",
        ["database"],
        ["prisma"],
        load_triggers=["database-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/portal-mode",
        ".claude/context/portal-mode.md",
        ["consciousness"],
        load_triggers=["portal-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/browser-automation",
        ".claude/context/browser-automation.md",
        ["browser"],
        ["playwright"],
        load_triggers=["browser-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/research-navigation",
        ".claude/context/research-navigation.md",
        ["infrastructure"],
        load_triggers=["research-work"],
    ))

    items.append(_make_infrastructure_item(
        "/context/infrastructure/freeform-conversation",
        ".claude/context/freeform-conversation.md",
        ["engagement"],
        ["telegram"],
        load_triggers=["freeform-chat"],
    ))

    # Domain knowledge files
    items.append(_make_domain_item(
        "/context/domain/quick-facts",
        ".claude/grounding/quick-facts.json",
        ["infrastructure"],
        load_triggers=["public-action", "research-work"],
    ))

    items.append(_make_domain_item(
        "/context/domain/accounts-registry",
        ".claude/accounts-registry.json",
        ["platform"],
        load_triggers=["public-action", "platform-work"],
    ))

    items.append(_make_domain_item(
        "/context/domain/portal-project-facts",
        ".claude/grounding/portal-project-facts.md",
        ["infrastructure"],
        load_triggers=["research-work", "public-action"],
    ))

    # Build manifest
    manifest = {
        "version": 2,
        "schema_version": "2.0.0",
        "last_lifecycle_run": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "migration_stage": 2,
        "items": items,
    }

    save_manifest(manifest, session_id)

    # Record in history
    for item in items:
        history.append_entry(
            "create",
            item["id"],
            session_id,
            payload={
                "content_hash": item["content_hash"],
                "category": item["category"],
                "memory_type": item["memory_type"],
                "migration": "stage_1_2",
            }
        )

    return manifest


def list_items(category=None):
    """List manifest items, optionally filtered by category."""
    manifest = load_manifest()
    if not manifest:
        return []

    items = manifest.get("items", [])
    if category:
        items = [i for i in items if i.get("category") == category]

    return items


def get_item(item_id):
    """Get a specific item by ID."""
    manifest = load_manifest()
    if not manifest:
        return None

    for item in manifest.get("items", []):
        if item.get("id") == item_id:
            return item
    return None


def manifest_stats():
    """Get manifest statistics."""
    manifest = load_manifest()
    if not manifest:
        return {"status": "no_manifest"}

    items = manifest.get("items", [])
    by_category = {}
    by_type = {}
    total_tokens = 0

    for item in items:
        cat = item.get("category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + 1

        mem_type = item.get("memory_type", "unknown")
        by_type[mem_type] = by_type.get(mem_type, 0) + 1

        total_tokens += item.get("tokens_est", 0)

    return {
        "total_items": len(items),
        "by_category": by_category,
        "by_memory_type": by_type,
        "total_tokens_est": total_tokens,
        "schema_version": manifest.get("schema_version"),
        "migration_stage": manifest.get("migration_stage"),
        "last_lifecycle_run": manifest.get("last_lifecycle_run"),
    }


def sign_manifest():
    """HMAC-sign the manifest."""
    manifest = load_manifest()
    if not manifest:
        print("No manifest to sign", file=sys.stderr)
        return None

    hmac_mod = _import_hmac()
    # Remove old signature, set final timestamp, then sign
    manifest.pop("hmac_signature", None)
    manifest["last_lifecycle_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    sig = hmac_mod.sign_content(canonical, hmac_mod.get_key())
    manifest["hmac_signature"] = sig
    # Write directly (not via save_manifest which updates timestamp again)
    atomic_write_json(MANIFEST_FILE, manifest)
    return sig


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "init":
        session = sys.argv[2] if len(sys.argv) > 2 else "AUT-2279-wo"
        manifest = init_manifest(session)
        stats = manifest_stats()
        print(json.dumps(stats, indent=2))
        print(f"\nManifest initialized with {stats['total_items']} items (Migration Stage 1-2)")

    elif cmd == "list":
        category = None
        if "--category" in sys.argv:
            idx = sys.argv.index("--category")
            category = sys.argv[idx + 1]
        items = list_items(category)
        for item in items:
            print(f"  {item['id']} [{item['category']}] {item.get('path', item.get('content_inline', '')[:60])}")
        print(f"\n{len(items)} items")

    elif cmd == "get":
        if len(sys.argv) < 3:
            print("Usage: playbook-manifest.py get <item_id>", file=sys.stderr)
            sys.exit(1)
        item = get_item(sys.argv[2])
        if item:
            print(json.dumps(item, indent=2))
        else:
            print("Not found", file=sys.stderr)
            sys.exit(1)

    elif cmd == "stats":
        stats = manifest_stats()
        print(json.dumps(stats, indent=2))

    elif cmd == "sign":
        sig = sign_manifest()
        if sig:
            print(f"Manifest signed: {sig[:16]}...")

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
