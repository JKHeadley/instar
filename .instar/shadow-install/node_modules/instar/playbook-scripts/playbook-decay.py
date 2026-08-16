#!/usr/bin/env python3
"""
Playbook Decay Functions — memory_type-specific relevance decay.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 4.8 Cycle 3).

Implements per-memory-type decay rates from governance:
  - fact: 0.01 (near-zero, invalidated by infrastructure changes, not time)
  - experiential: 0.05 (medium decay by task-domain recency)
  - episodic: 0.15 (aggressive decay, session-specific observations)
  - procedural: 0.03 (low decay, how-to knowledge stable unless tool changes)
  - historical: 0.0 (no decay, permanent record items)

Identity/safety items have permanent relevance floor (no decay regardless).
Retirement grace period: items in low-activity domains (no session touched
that domain in 30+ days) get 30-day grace before decay applies.

Usage:
    python3 playbook-decay.py score <item_id>       # Score one item
    python3 playbook-decay.py score-all              # Score all active items
    python3 playbook-decay.py grace-check            # Check grace periods

Library usage:
    from playbook_decay import compute_relevance, compute_decay_rate
    from playbook_decay import is_grace_period, score_all_items
"""

import json
import math
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest
GOVERNANCE_FILE = _paths.governance
ASSEMBLY_LOG = _paths.assembly_log

DEFAULT_DECAY_RATES = {
    "fact": 0.01,
    "experiential": 0.05,
    "episodic": 0.15,
    "procedural": 0.03,
    "historical": 0.0,
}

GRACE_PERIOD_DAYS = 30
IDENTITY_SAFETY_FLOOR = float("inf")


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


def _days_since(timestamp_str):
    """Compute days since a timestamp string (ISO format)."""
    if not timestamp_str:
        return 365
    try:
        ts = timestamp_str.replace("Z", "+00:00")
        if "T" in ts:
            from datetime import datetime, timezone
            ts = ts.replace("Z", "+00:00")
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            delta = now - dt
            return max(0, delta.days)
        return 365
    except (ValueError, TypeError):
        return 365


def compute_decay_rate(memory_type, governance=None):
    """Get the decay rate for a memory type."""
    if governance:
        type_decay = governance.get("memory_type_decay", {})
        entry = type_decay.get(memory_type, {})
        if isinstance(entry, dict) and "decay_rate" in entry:
            return entry["decay_rate"]
    return DEFAULT_DECAY_RATES.get(memory_type, 0.05)


def is_exempt_from_decay(item, governance=None):
    """Check if an item is exempt from decay."""
    category = item.get("category", "")
    if category in ("identity", "safety"):
        return True
    if governance:
        policy = governance.get("category_policies", {}).get(category, {})
        if policy.get("scoring_exempt", False):
            return True
    if item.get("memory_type") == "historical":
        return True
    return False


def _get_domain_last_activity(domains, assembly_log_path=None):
    """Get the most recent session activity for each domain from assembly log."""
    log_path = assembly_log_path or ASSEMBLY_LOG
    domain_activity = {}
    if not os.path.exists(log_path):
        return domain_activity
    try:
        with open(log_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    triggers = entry.get("triggers", [])
                    timestamp = entry.get("timestamp", "")
                    for trigger in triggers:
                        trigger_lower = trigger.lower().replace("-work", "").replace("-action", "")
                        if trigger_lower in domains:
                            existing = domain_activity.get(trigger_lower, "")
                            if timestamp > existing:
                                domain_activity[trigger_lower] = timestamp
                    for item_id in entry.get("selected", []):
                        parts = item_id.split("/")
                        if len(parts) >= 4:
                            item_domain = parts[3]
                            if item_domain in domains:
                                existing = domain_activity.get(item_domain, "")
                                if timestamp > existing:
                                    domain_activity[item_domain] = timestamp
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return domain_activity


def is_grace_period(item, governance=None, domain_activity=None):
    """
    Check if an item qualifies for a grace period.

    Returns (is_in_grace, days_remaining) tuple.
    """
    if is_exempt_from_decay(item, governance):
        return False, 0
    tags = item.get("tags", {})
    item_domains = tags.get("domains", [])
    if not item_domains:
        return False, 0
    if domain_activity is None:
        all_domains = set()
        if governance:
            all_domains = set(governance.get("tag_vocabulary", {}).get("domains", []))
        domain_activity = _get_domain_last_activity(all_domains)
    any_recent = False
    for domain in item_domains:
        last_active = domain_activity.get(domain, "")
        if last_active:
            days = _days_since(last_active)
            if days < GRACE_PERIOD_DAYS:
                any_recent = True
                break
    if any_recent:
        return False, 0
    freshness = item.get("freshness", "")
    days_since_fresh = _days_since(freshness)
    if days_since_fresh < GRACE_PERIOD_DAYS:
        remaining = GRACE_PERIOD_DAYS - days_since_fresh
        return True, remaining
    return False, 0


def _recency_weight(days, decay_rate):
    """Compute recency weight: exp(-decay_rate * days)."""
    if decay_rate <= 0:
        return 1.0
    return math.exp(-decay_rate * days)


def compute_relevance(item, governance=None, domain_activity=None):
    """
    Compute relevance score for a manifest item.

    Returns dict with score, decay_rate, days_since_fresh, recency_weight,
    is_exempt, grace_period, grace_days_remaining.
    """
    if is_exempt_from_decay(item, governance):
        return {
            "score": IDENTITY_SAFETY_FLOOR,
            "decay_rate": 0.0,
            "days_since_fresh": 0,
            "recency_weight": 1.0,
            "is_exempt": True,
            "grace_period": False,
            "grace_days_remaining": 0,
        }
    memory_type = item.get("memory_type", "experiential")
    decay_rate = compute_decay_rate(memory_type, governance)
    usefulness = item.get("usefulness", {})
    helpful = usefulness.get("helpful", 0)
    freshness = item.get("freshness", "")
    days = _days_since(freshness)
    in_grace, grace_remaining = is_grace_period(item, governance, domain_activity)
    if in_grace:
        return {
            "score": float(helpful) if helpful > 0 else 0.1,
            "decay_rate": decay_rate,
            "days_since_fresh": days,
            "recency_weight": 1.0,
            "is_exempt": False,
            "grace_period": True,
            "grace_days_remaining": grace_remaining,
        }
    recency = _recency_weight(days, decay_rate)
    score = helpful * recency
    return {
        "score": score,
        "decay_rate": decay_rate,
        "days_since_fresh": days,
        "recency_weight": recency,
        "is_exempt": False,
        "grace_period": False,
        "grace_days_remaining": 0,
    }


def score_all_items(manifest=None, governance=None):
    """Score all active items. Returns list sorted by score ascending."""
    if manifest is None:
        manifest = _load_manifest()
    if manifest is None:
        return {"status": "error", "message": "No manifest found"}
    if governance is None:
        governance = _load_governance()
    items = manifest.get("items", [])
    active_items = [i for i in items if i.get("status") == "active"]
    all_domains = set()
    if governance:
        all_domains = set(governance.get("tag_vocabulary", {}).get("domains", []))
    domain_activity = _get_domain_last_activity(all_domains)
    scored = []
    for item in active_items:
        relevance = compute_relevance(item, governance, domain_activity)
        scored.append({
            "id": item["id"],
            "category": item.get("category", ""),
            "memory_type": item.get("memory_type", ""),
            "relevance": relevance,
        })
    scored.sort(key=lambda x: x["relevance"]["score"])
    return scored


def identify_retirement_candidates(manifest=None, governance=None, threshold=0.1):
    """Identify items below threshold, not in grace, not exempt."""
    scored = score_all_items(manifest, governance)
    if isinstance(scored, dict) and scored.get("status") == "error":
        return scored
    candidates = []
    for item in scored:
        rel = item["relevance"]
        if (not rel["is_exempt"]
                and not rel["grace_period"]
                and rel["score"] < threshold):
            candidates.append(item)
    return candidates


def check_capacity(manifest=None, governance=None):
    """Check if manifest is above capacity trigger threshold."""
    if manifest is None:
        manifest = _load_manifest()
    if governance is None:
        governance = _load_governance()
    if not manifest or not governance:
        return False, {}
    items = manifest.get("items", [])
    active = [i for i in items if i.get("status") == "active"]
    active_count = len(active)
    caps = governance.get("item_caps", {})
    total_cap = caps.get("total_active", 1500)
    trigger_pct = caps.get("weekly_retirement_trigger_pct", 80)
    threshold = total_cap * trigger_pct / 100
    by_category = {}
    for item in active:
        cat = item.get("category", "unknown")
        by_category[cat] = by_category.get(cat, 0) + 1
    category_status = {}
    for cat, count in by_category.items():
        cat_cap = caps.get(cat)
        if cat_cap and cat_cap != "exempt":
            category_status[cat] = {
                "count": count,
                "cap": cat_cap,
                "pct": round(count / cat_cap * 100, 1),
                "over_threshold": count >= cat_cap * trigger_pct / 100,
            }
    return active_count >= threshold, {
        "active_count": active_count,
        "total_cap": total_cap,
        "trigger_pct": trigger_pct,
        "threshold": threshold,
        "over_threshold": active_count >= threshold,
        "by_category": category_status,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "score" and len(sys.argv) >= 3:
        item_id = sys.argv[2]
        manifest = _load_manifest()
        governance = _load_governance()
        if not manifest:
            print("No manifest found", file=sys.stderr)
            sys.exit(1)
        for item in manifest.get("items", []):
            if item.get("id") == item_id:
                result = compute_relevance(item, governance)
                print(json.dumps(result, indent=2))
                sys.exit(0)
        print(f"Item not found: {item_id}", file=sys.stderr)
        sys.exit(1)
    elif cmd == "score-all":
        scored = score_all_items()
        if isinstance(scored, dict) and scored.get("status") == "error":
            print(scored["message"], file=sys.stderr)
            sys.exit(1)
        for item in scored:
            rel = item["relevance"]
            flags = []
            if rel["is_exempt"]:
                flags.append("EXEMPT")
            if rel["grace_period"]:
                flags.append(f"GRACE({rel['grace_days_remaining']}d)")
            flag_str = f" [{', '.join(flags)}]" if flags else ""
            print(f"  {item['id']}: score={rel['score']:.3f} "
                  f"type={item['memory_type']} decay={rel['decay_rate']}{flag_str}")
    elif cmd == "grace-check":
        manifest = _load_manifest()
        governance = _load_governance()
        if not manifest:
            print("No manifest found", file=sys.stderr)
            sys.exit(1)
        for item in manifest.get("items", []):
            if item.get("status") != "active":
                continue
            in_grace, remaining = is_grace_period(item, governance)
            if in_grace:
                print(f"  {item['id']}: GRACE PERIOD ({remaining} days remaining)")
    elif cmd == "capacity":
        over, details = check_capacity()
        print(json.dumps(details, indent=2))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
