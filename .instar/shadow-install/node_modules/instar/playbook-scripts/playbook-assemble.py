#!/usr/bin/env python3
"""
Playbook Context Assembly — tag-based context selection with budget awareness.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.3).

Assembles context for a task by:
1. Matching trigger tags against manifest items
2. Sorting by category priority, provenance weight, usefulness, freshness
3. Applying primacy/recency ordering (identity first and last)
4. Fitting within dynamic token budget
5. Logging assembly decisions (inclusions AND exclusions with reasons)

Phase 1: Strict tag matching (deterministic, fast)
Phase 2+: Hybrid tag + semantic similarity (planned)

Usage:
    python3 playbook-assemble.py <trigger> [<trigger2> ...]
    python3 playbook-assemble.py --triggers "database-work,code-work"
    python3 playbook-assemble.py --triggers "session-start" --budget 5000
    python3 playbook-assemble.py --triggers "public-action" --format paths
    python3 playbook-assemble.py --triggers "database-work" --dry-run
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
ASSEMBLY_LOG = _paths.assembly_log

# Category priority (lower = higher priority)
CATEGORY_PRIORITY = {
    "identity": 0,
    "safety": 1,
    "infrastructure": 2,
    "strategy": 3,
    "lesson": 4,
    "domain": 5,
}

# Provenance weight (higher = more trusted)
PROVENANCE_WEIGHT = {
    "human-verified": 3,
    "session-generated": 2,
    "system-computed": 1,
}

# Trigger-to-tag expansion rules
TRIGGER_TAG_EXPANSION = {
    "session-start": {"domains": ["identity", "infrastructure"], "qualifiers": []},
    "compaction": {"domains": ["identity"], "qualifiers": []},
    "public-action": {"domains": ["identity", "engagement", "economics"], "qualifiers": []},
    "database-work": {"domains": ["database"], "qualifiers": ["prisma", "sqlite", "postgres"]},
    "code-work": {"domains": ["infrastructure"], "qualifiers": ["nextjs"]},
    "testing-work": {"domains": ["testing"], "qualifiers": ["jest", "cypress"]},
    "portal-work": {"domains": ["consciousness"], "qualifiers": []},
    "browser-work": {"domains": ["browser"], "qualifiers": ["playwright"]},
    "economics-work": {"domains": ["economics"], "qualifiers": []},
    "platform-work": {"domains": ["platform"], "qualifiers": []},
    "deployment-work": {"domains": ["deployment"], "qualifiers": ["vercel"]},
    "research-work": {"domains": ["infrastructure"], "qualifiers": []},
    "freeform-chat": {"domains": ["engagement"], "qualifiers": ["telegram"]},
}

DEFAULT_BUDGET = 8000


def load_manifest(verify_hmac=True):
    """Load manifest with optional HMAC verification (Section 3.7 failsafe)."""
    if verify_hmac:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "playbook_failsafe",
                os.path.join(SCRIPT_DIR, "playbook-failsafe.py"))
            failsafe = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(failsafe)
            manifest, mode = failsafe.verified_manifest_read()
            if mode.is_degraded:
                # Log degraded mode but still return whatever manifest we got
                import sys as _sys
                print(f"[Playbook] Degraded mode: {mode.reason}", file=_sys.stderr)
            return manifest
        except Exception:
            pass  # Fall through to direct read if failsafe unavailable

    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def load_governance():
    if not os.path.exists(GOVERNANCE_FILE):
        return None
    with open(GOVERNANCE_FILE, "r") as f:
        return json.load(f)


def _expand_triggers(triggers):
    """Expand triggers to tag sets."""
    domains = set()
    qualifiers = set()
    for trigger in triggers:
        expansion = TRIGGER_TAG_EXPANSION.get(trigger, {})
        domains.update(expansion.get("domains", []))
        qualifiers.update(expansion.get("qualifiers", []))
    return domains, qualifiers


def _item_matches_triggers(item, trigger_domains, trigger_qualifiers):
    """Check if an item's tags match any trigger tags."""
    tags = item.get("tags", {})
    item_domains = set(tags.get("domains", []))
    item_qualifiers = set(tags.get("qualifiers", []))

    # Match if any domain or qualifier overlaps
    domain_match = bool(item_domains & trigger_domains)
    qualifier_match = bool(item_qualifiers & trigger_qualifiers) if trigger_qualifiers else False

    return domain_match or qualifier_match


def _item_has_load_trigger(item, triggers):
    """Check if item has a matching load_trigger."""
    load_triggers = set(item.get("load_triggers", []))
    return bool(load_triggers & set(triggers))


def _provenance_score(item):
    """Get the highest provenance weight for an item."""
    provenance = item.get("provenance", [])
    if not provenance:
        return 1
    return max(PROVENANCE_WEIGHT.get(p.get("provenance_type", ""), 1) for p in provenance)


def _usefulness_ratio(item):
    """Compute usefulness ratio (helpful / (helpful + misleading + 1))."""
    u = item.get("usefulness", {})
    helpful = u.get("helpful", 0)
    misleading = u.get("misleading", 0)
    return helpful / (helpful + misleading + 1)


def _sort_key(item):
    """Sort key: (category_priority, -provenance, -usefulness, -freshness)."""
    cat_priority = CATEGORY_PRIORITY.get(item.get("category", ""), 99)
    prov = -_provenance_score(item)
    useful = -_usefulness_ratio(item)
    freshness = item.get("freshness", "")
    return (cat_priority, prov, useful, freshness)


def assemble(triggers, budget=DEFAULT_BUDGET, session_id="unknown", dry_run=False):
    """
    Assemble context items for the given triggers.

    Returns:
        dict with 'selected', 'excluded', 'rationale', 'budget_used', 'budget_available'
    """
    manifest = load_manifest()
    if not manifest:
        return {"error": "No manifest file", "selected": [], "excluded": []}

    trigger_domains, trigger_qualifiers = _expand_triggers(triggers)
    items = manifest.get("items", [])

    # Phase 1: Select candidates via tag matching + load trigger matching
    candidates = []
    non_matches = []

    for item in items:
        if item.get("status") == "quarantine":
            non_matches.append({"item": item, "reason": "quarantined"})
            continue

        # Two matching paths: direct load_trigger match OR tag match
        trigger_match = _item_has_load_trigger(item, triggers)
        tag_match = _item_matches_triggers(item, trigger_domains, trigger_qualifiers)

        if trigger_match or tag_match:
            candidates.append(item)
        else:
            non_matches.append({
                "item": item,
                "reason": "no_trigger_match",
                "score": _usefulness_ratio(item),
            })

    # Phase 2: Sort candidates
    candidates.sort(key=_sort_key)

    # Phase 3: Pack into budget with primacy/recency ordering
    selected = []
    excluded_budget = []
    budget_used = 0

    # First pass: identity/safety items always included (exempt from budget for inclusion decision)
    identity_items = []
    other_items = []
    for item in candidates:
        if item.get("category") in ("identity", "safety"):
            identity_items.append(item)
        else:
            other_items.append(item)

    # Include identity items (priority)
    for item in identity_items:
        tokens = item.get("tokens_est", 0)
        if budget_used + tokens <= budget:
            selected.append(item)
            budget_used += tokens
        else:
            excluded_budget.append({
                "id": item["id"],
                "reason": "budget_exceeded",
                "tokens": tokens,
            })

    # Include other items
    for item in other_items:
        tokens = item.get("tokens_est", 0)
        if budget_used + tokens <= budget:
            selected.append(item)
            budget_used += tokens
        else:
            excluded_budget.append({
                "id": item["id"],
                "reason": "budget_exceeded",
                "tokens": tokens,
            })

    # Phase 4: Primacy/recency ordering
    # Identity at start, then others sorted by priority, identity summary at end
    ordered = _apply_primacy_recency(selected)

    # Build excluded list
    excluded = []
    for nm in non_matches:
        excluded.append({
            "id": nm["item"]["id"],
            "reason": nm["reason"],
            "score": nm.get("score", 0),
        })
    excluded.extend(excluded_budget)

    # Build Constructor rationale preamble (Phase 2 enhanced)
    selected_parts = []
    for i in ordered[:5]:
        slug = i['id'].split('/')[-1]
        match_reason = "always" if i['category'] in ('identity', 'safety') else f"matched {','.join(triggers)}"
        selected_parts.append(f"{slug} ({i['category']}, {match_reason})")
    selected_desc = ", ".join(selected_parts)
    if len(ordered) > 5:
        selected_desc += f", +{len(ordered) - 5} more"

    # Summarize exclusion reasons
    exclusion_summary = {}
    for ex in excluded:
        reason = ex.get("reason", "unknown")
        exclusion_summary[reason] = exclusion_summary.get(reason, 0) + 1
    excl_desc = ", ".join(f"{v} {k}" for k, v in sorted(exclusion_summary.items(), key=lambda x: -x[1]))

    rationale = (
        f"[Playbook loaded for triggers {triggers}: {selected_desc}. "
        f"Budget used: {budget_used}/{budget} tokens. "
        f"{len(excluded)} items excluded"
        + (f" ({excl_desc})" if excl_desc else "")
        + ".]"
    )

    result = {
        "triggers": triggers,
        "selected": [{"id": i["id"], "category": i["category"], "path": i.get("path", ""), "tokens": i.get("tokens_est", 0)} for i in ordered],
        "excluded": excluded[:10],  # Cap logged exclusions
        "budget_used": budget_used,
        "budget_available": budget,
        "rationale": rationale,
        "total_candidates": len(candidates),
        "total_selected": len(ordered),
        "total_excluded": len(excluded),
    }

    # Log the assembly
    if not dry_run:
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "session_id": session_id,
            "triggers": triggers,
            "selected": [i["id"] for i in ordered],
            "excluded": excluded[:10],
            "budget_used": budget_used,
            "budget_available": budget,
        }
        atomic_append(ASSEMBLY_LOG, json.dumps(log_entry, separators=(",", ":")))

    return result


def _apply_primacy_recency(items):
    """Apply primacy/recency ordering: identity first and last."""
    if not items:
        return items

    identity = [i for i in items if i.get("category") in ("identity", "safety")]
    others = [i for i in items if i.get("category") not in ("identity", "safety")]

    if not identity:
        return others

    # Split identity: most important at start, soul/pulse at end
    primary_identity = identity[:2]  # Core identity items first
    recap_identity = identity[2:] if len(identity) > 2 else []

    return primary_identity + others + recap_identity


def get_paths_for_triggers(triggers, budget=DEFAULT_BUDGET):
    """Convenience: get just the file paths for assembly."""
    result = assemble(triggers, budget, dry_run=True)
    paths = []
    for item in result.get("selected", []):
        if item.get("path"):
            paths.append(item["path"])
    return paths


def main():
    triggers = []
    budget = DEFAULT_BUDGET
    output_format = "full"
    dry_run = False
    session_id = "unknown"

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--triggers":
            i += 1
            triggers = sys.argv[i].split(",")
        elif arg == "--budget":
            i += 1
            budget = int(sys.argv[i])
        elif arg == "--format":
            i += 1
            output_format = sys.argv[i]
        elif arg == "--dry-run":
            dry_run = True
        elif arg == "--session":
            i += 1
            session_id = sys.argv[i]
        elif not arg.startswith("--"):
            triggers.append(arg)
        i += 1

    if not triggers:
        print(__doc__)
        sys.exit(1)

    result = assemble(triggers, budget, session_id, dry_run)

    if output_format == "paths":
        for item in result.get("selected", []):
            if item.get("path"):
                print(item["path"])
    elif output_format == "rationale":
        print(result.get("rationale", ""))
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
