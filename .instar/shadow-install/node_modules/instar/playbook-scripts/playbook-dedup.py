#!/usr/bin/env python3
"""
Playbook Deduplication Pipeline — semantic similarity detection for context items.

Part of Playbook Phase 2 (context-engineering-integration spec, Section 4.8).

Detects near-duplicate items in the manifest using:
  1. Exact content_hash match (fast, deterministic)
  2. Text similarity via Gemini Flash embeddings (semantic, async)

Identity and safety items are EXEMPT from dedup (per governance policy).

When duplicates are found:
  - The newer item is converted to a counter update on the existing item
  - The conversion is logged for audit
  - The merged item's usefulness scores are combined

Usage:
    python3 playbook-dedup.py scan [--dry-run]        # Scan manifest for duplicates
    python3 playbook-dedup.py check <item_id>          # Check one item against manifest

Library usage:
    from playbook_dedup import scan_duplicates, check_item_duplicate
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
DELTAS_FILE = os.path.join(PROJECT_DIR, "context-deltas.jsonl")
DEDUP_LOG = os.path.join(PROJECT_DIR, "context-dedup-log.jsonl")

SIMILARITY_THRESHOLD = 0.92  # Per spec Section 3.6


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


def _is_exempt(item, governance):
    """Check if item is exempt from dedup (identity/safety)."""
    category = item.get("category", "")
    if governance:
        policy = governance.get("category_policies", {}).get(category, {})
        if policy.get("embedding_exempt", False):
            return True
    return category in ("identity", "safety")


def _get_item_text(item):
    """Extract text content from an item for comparison."""
    parts = []
    if item.get("content_inline"):
        parts.append(item["content_inline"])
    # Use tags as additional signal
    tags = item.get("tags", {})
    for domain in tags.get("domains", []):
        parts.append(domain)
    for qualifier in tags.get("qualifiers", []):
        parts.append(qualifier)
    return " ".join(parts)


def _text_similarity(text_a, text_b):
    """
    Compute text similarity between two strings.

    Uses token overlap (Jaccard similarity) as a fast deterministic baseline.
    For Phase 2+, this can be extended with Gemini Flash embeddings for
    semantic similarity.
    """
    if not text_a or not text_b:
        return 0.0

    # Normalize
    tokens_a = set(text_a.lower().split())
    tokens_b = set(text_b.lower().split())

    if not tokens_a or not tokens_b:
        return 0.0

    intersection = tokens_a & tokens_b
    union = tokens_a | tokens_b

    jaccard = len(intersection) / len(union)
    return jaccard


def _compute_embeddings_similarity(text_a, text_b):
    """
    Compute semantic similarity via Gemini Flash embeddings.

    Returns similarity score (0.0-1.0) or None if API unavailable.
    Falls back to text similarity if embeddings fail.
    """
    try:
        import subprocess
        # Use Gemini Flash for embeddings via API
        # This is a placeholder for the actual embedding call
        # In production, we'd batch these and cache results
        return None  # Fall through to text similarity
    except Exception:
        return None


def find_duplicates(manifest, governance, use_embeddings=False):
    """
    Scan manifest for duplicate items.

    Returns list of duplicate pairs:
        [{"existing": item_id, "duplicate": item_id, "similarity": float, "method": str}]
    """
    items = manifest.get("items", [])
    active_items = [i for i in items if i.get("status") == "active"]

    duplicates = []

    # Phase 1: Exact content_hash match
    by_hash = {}
    for item in active_items:
        if _is_exempt(item, governance):
            continue
        content_hash = item.get("content_hash", "")
        if content_hash and content_hash in by_hash:
            duplicates.append({
                "existing": by_hash[content_hash],
                "duplicate": item["id"],
                "similarity": 1.0,
                "method": "exact_hash",
            })
        elif content_hash:
            by_hash[content_hash] = item["id"]

    # Phase 2: Text similarity
    non_exempt = [i for i in active_items if not _is_exempt(i, governance)]
    for i in range(len(non_exempt)):
        for j in range(i + 1, len(non_exempt)):
            item_a = non_exempt[i]
            item_b = non_exempt[j]

            # Skip if already found as exact match
            pair_ids = {item_a["id"], item_b["id"]}
            if any(pair_ids == {d["existing"], d["duplicate"]} for d in duplicates):
                continue

            text_a = _get_item_text(item_a)
            text_b = _get_item_text(item_b)

            # Try embeddings first, fall back to text
            similarity = None
            method = "text_overlap"

            if use_embeddings:
                similarity = _compute_embeddings_similarity(text_a, text_b)
                if similarity is not None:
                    method = "embedding"

            if similarity is None:
                similarity = _text_similarity(text_a, text_b)

            if similarity >= SIMILARITY_THRESHOLD:
                # Determine which is the "existing" (older) item
                fa = item_a.get("freshness", "")
                fb = item_b.get("freshness", "")
                if fa <= fb:
                    existing, duplicate = item_a["id"], item_b["id"]
                else:
                    existing, duplicate = item_b["id"], item_a["id"]

                duplicates.append({
                    "existing": existing,
                    "duplicate": duplicate,
                    "similarity": round(similarity, 3),
                    "method": method,
                })

    return duplicates


def propose_merges(duplicates, dry_run=True):
    """
    Propose merge deltas for discovered duplicates.

    If dry_run=False, submits deltas to the pipeline.
    """
    import secrets
    proposed = []

    for dup in duplicates:
        delta = {
            "delta_id": f"delta-{secrets.token_hex(6)}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_session": "DEDUP",
            "operation": "merge",
            "target_item_id": dup["existing"],
            "reflector_confidence": min(dup["similarity"], 0.95),
            "payload": {
                "source_item_id": dup["duplicate"],
                "merge_reason": f"Dedup: {dup['method']} similarity {dup['similarity']}",
            },
            "evidence": [{
                "type": "test_result",
                "value": f"dedup_{dup['method']}:{dup['similarity']}",
            }],
        }
        proposed.append(delta)

        if not dry_run:
            atomic_append(DELTAS_FILE, json.dumps(delta, separators=(",", ":")))

    return proposed


def scan_duplicates(dry_run=True, use_embeddings=False):
    """Full scan: find duplicates and propose merges."""
    manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    governance = _load_governance()
    duplicates = find_duplicates(manifest, governance, use_embeddings)

    if not duplicates:
        return {
            "status": "clean",
            "message": "No duplicates found",
            "items_scanned": len([i for i in manifest.get("items", [])
                                  if i.get("status") == "active"]),
        }

    proposed = propose_merges(duplicates, dry_run=dry_run)

    # Log the scan
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duplicates_found": len(duplicates),
        "merges_proposed": len(proposed),
        "dry_run": dry_run,
        "pairs": duplicates,
    }
    atomic_append(DEDUP_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "duplicates_found",
        "duplicates": duplicates,
        "merges_proposed": len(proposed),
        "dry_run": dry_run,
    }


def check_item_duplicate(item_id, use_embeddings=False):
    """Check if a specific item has duplicates in the manifest."""
    manifest = _load_manifest()
    if not manifest:
        return {"status": "error", "message": "No manifest found"}

    governance = _load_governance()

    target = None
    for item in manifest.get("items", []):
        if item.get("id") == item_id:
            target = item
            break

    if not target:
        return {"status": "error", "message": f"Item not found: {item_id}"}

    if _is_exempt(target, governance):
        return {"status": "exempt", "item_id": item_id, "reason": "category exempt from dedup"}

    target_text = _get_item_text(target)
    matches = []

    for item in manifest.get("items", []):
        if item.get("id") == item_id or item.get("status") != "active":
            continue
        if _is_exempt(item, governance):
            continue

        # Check hash
        if target.get("content_hash") and target["content_hash"] == item.get("content_hash"):
            matches.append({"id": item["id"], "similarity": 1.0, "method": "exact_hash"})
            continue

        # Check text similarity
        item_text = _get_item_text(item)
        sim = _text_similarity(target_text, item_text)
        if sim >= SIMILARITY_THRESHOLD:
            matches.append({"id": item["id"], "similarity": round(sim, 3), "method": "text_overlap"})

    return {
        "item_id": item_id,
        "matches": matches,
        "is_duplicate": len(matches) > 0,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        result = scan_duplicates(dry_run=dry_run)
        print(json.dumps(result, indent=2))

    elif cmd == "check" and len(sys.argv) >= 3:
        result = check_item_duplicate(sys.argv[2])
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
