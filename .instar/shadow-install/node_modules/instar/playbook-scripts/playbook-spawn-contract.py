#!/usr/bin/env python3
"""
Playbook Spawned Session Contract — context inheritance for sub-agents.

Part of Playbook Phase 1 (context-engineering-integration spec, Section 4.6).

When a session spawns a sub-agent via the Task tool, this script assembles
a context preamble that gives the sub-agent relevant context from the manifest.

The contract is embedded in the Task tool prompt by the SPAWNING session.
Sub-agents do not detect or request context on their own.

Contract levels:
  - minimal: ~500 tokens. Identity + safety only.
  - domain:  ~2000 tokens. Identity + relevant domain context.
  - full:    ~5000 tokens. Identity + domain + world model + scratchpad.

Usage:
    python3 playbook-spawn-contract.py --agent-type Explore --task "research X"
    python3 playbook-spawn-contract.py --agent-type general-purpose --task "fix database"
    python3 playbook-spawn-contract.py --level domain --triggers "database-work"

Library usage:
    from playbook_spawn_contract import build_preamble
    preamble = build_preamble(agent_type="Explore", task_description="research X")
"""

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
MANIFEST_FILE = _paths.manifest

# Token budgets per contract level
LEVEL_BUDGETS = {
    "minimal": 500,
    "domain": 2000,
    "full": 5000,
}

# Agent type to contract level mapping
AGENT_LEVEL_MAP = {
    "Explore": "domain",
    "Plan": "domain",
    "general-purpose": "full",
    # Guardian/auditor agents get domain context
    "coherence-guardian": "domain",
    "testing-guardian": "domain",
    "meta-awareness-auditor": "domain",
    "agent-coherence-auditor": "domain",
    "documentation-coherence-auditor": "domain",
    "structural-coherence-auditor": "domain",
    "system-observability-guardian": "domain",
    "identity-coherence-guardian": "domain",
    "context-efficiency-guardian": "domain",
    "grounding-guardian": "domain",
    "evolution-catalyst": "domain",
    "meta-evolution-guardian": "domain",
    # Engagement agents need full context
    "engagement-evolution-agent": "full",
    "economic-alignment-auditor": "full",
    "economic-metrics-tracker": "full",
    # Quick/focused agents get minimal
    "haiku": "minimal",
}

# Keywords in task description that suggest trigger types
TASK_KEYWORD_TRIGGERS = {
    "database": ["database-work"],
    "prisma": ["database-work"],
    "schema": ["database-work"],
    "test": ["testing-work"],
    "cypress": ["testing-work"],
    "jest": ["testing-work"],
    "portal": ["portal-work"],
    "consciousness": ["portal-work"],
    "memory": ["portal-work"],
    "browser": ["browser-work"],
    "playwright": ["browser-work"],
    "chrome": ["browser-work"],
    "economics": ["economics-work"],
    "revenue": ["economics-work"],
    "growth": ["economics-work"],
    "platform": ["platform-work"],
    "deploy": ["deployment-work"],
    "vercel": ["deployment-work"],
    "research": ["research-work"],
    "engagement": ["public-action"],
    "post": ["public-action"],
    "tweet": ["public-action"],
    "reddit": ["public-action"],
    "x ": ["public-action"],
    "telegram": ["freeform-chat"],
}


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _determine_level(agent_type, task_description=""):
    """Determine contract level from agent type and task keywords."""
    # Check direct mapping first
    level = AGENT_LEVEL_MAP.get(agent_type)

    # Check if agent type contains guardian/auditor patterns
    if not level:
        agent_lower = (agent_type or "").lower()
        if "guardian" in agent_lower or "auditor" in agent_lower:
            level = "domain"
        elif "agent" in agent_lower:
            level = "domain"

    # Default to minimal for unknown types
    if not level:
        level = "minimal"

    # Upgrade from minimal to domain if task has infrastructure keywords
    if level == "minimal" and task_description:
        task_lower = task_description.lower()
        infra_keywords = ["fix", "implement", "build", "refactor", "debug", "investigate"]
        if any(kw in task_lower for kw in infra_keywords):
            level = "domain"

    return level


def _determine_triggers(task_description):
    """Extract trigger types from task description keywords."""
    triggers = set()
    if not task_description:
        return list(triggers)

    task_lower = task_description.lower()
    for keyword, trigger_list in TASK_KEYWORD_TRIGGERS.items():
        if keyword in task_lower:
            triggers.update(trigger_list)

    return list(triggers)


def _select_inheritable_items(manifest, triggers, budget):
    """Select manifest items that are inheritance-eligible within budget."""
    if not manifest:
        return []

    items = manifest.get("items", [])

    # Filter to inheritance_eligible items (access_scope is orthogonal — controls
    # multi-tenant visibility, not sub-agent inheritance. inheritance_eligible is
    # the sole gate for sub-agent context propagation per Phase 4 reconciliation.)
    eligible = [
        item for item in items
        if item.get("inheritance_eligible", False)
        and item.get("status") == "active"
    ]

    # Import assembly logic for tag matching
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_assemble",
        os.path.join(SCRIPT_DIR, "playbook-assemble.py"))
    assemble_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assemble_mod)

    if triggers:
        trigger_domains, trigger_qualifiers = assemble_mod._expand_triggers(triggers)

        # Filter by trigger match
        matched = []
        for item in eligible:
            if assemble_mod._item_matches_triggers(item, trigger_domains, trigger_qualifiers):
                matched.append(item)
            elif assemble_mod._item_has_load_trigger(item, triggers):
                matched.append(item)
        eligible = matched if matched else eligible

    # Sort by usefulness ratio (most useful first)
    def usefulness_sort(item):
        u = item.get("usefulness", {})
        helpful = u.get("helpful", 0)
        misleading = u.get("misleading", 0)
        return -(helpful / (helpful + misleading + 1))

    eligible.sort(key=usefulness_sort)

    # Pack into budget
    selected = []
    used = 0
    for item in eligible:
        tokens = item.get("tokens_est", 0)
        if used + tokens <= budget:
            selected.append(item)
            used += tokens

    return selected


def _read_file_content(path, max_chars=None):
    """Read file content, with optional character limit."""
    abs_path = os.path.join(PROJECT_DIR, "..", path) if not os.path.isabs(path) else path
    if not os.path.exists(abs_path):
        abs_path = os.path.join(PROJECT_DIR, path)
    if not os.path.exists(abs_path):
        return None

    with open(abs_path, "r", errors="replace") as f:
        content = f.read()
    if max_chars and len(content) > max_chars:
        content = content[:max_chars] + "\n[... truncated for sub-agent budget ...]"
    return content


def build_preamble(agent_type="general-purpose", task_description="",
                   parent_session="unknown", parent_goal="",
                   level=None, triggers=None):
    """
    Build the context preamble for a sub-agent spawn.

    Returns a string that should be prepended to the Task tool's prompt.
    """
    manifest = _load_manifest()
    if not manifest:
        return ""

    # Determine contract level
    if not level:
        level = _determine_level(agent_type, task_description)

    budget = LEVEL_BUDGETS.get(level, 500)

    # Determine triggers
    if not triggers:
        triggers = _determine_triggers(task_description)

    # Select inheritable items
    selected = _select_inheritable_items(manifest, triggers, budget)

    if not selected:
        # Minimal identity header even with no items
        return (
            f"[Spawned by session {parent_session}. "
            f"Parent goal: {parent_goal or 'none specified'}. "
            f"Contract level: {level}. No inheritable context items matched.]\n\n"
        )

    # Build preamble
    parts = []

    # Identity header (always included)
    parts.append(f"[Spawned Session Contract — level: {level}]")
    parts.append(f"Parent session: {parent_session}")
    if parent_goal:
        parts.append(f"Parent goal: {parent_goal}")
    parts.append(f"Context items: {len(selected)} (budget: {budget} tokens)")
    parts.append("")

    # Include file paths for reference
    paths = [item.get("path", "") for item in selected if item.get("path")]
    if paths:
        parts.append("Inherited context files:")
        for path in paths:
            parts.append(f"  - {path}")
        parts.append("")

    # For full level, include inline content summaries
    if level == "full":
        for item in selected[:3]:  # Limit inline content to top 3
            path = item.get("path", "")
            if path:
                content = _read_file_content(path, max_chars=1000)
                if content:
                    parts.append(f"--- {item['id']} ({item['category']}) ---")
                    parts.append(content)
                    parts.append("")

    parts.append("[End Spawned Session Contract]")
    parts.append("")

    return "\n".join(parts)


def main():
    agent_type = "general-purpose"
    task_description = ""
    level = None
    triggers = None
    parent_session = os.environ.get("DAWN_SESSION_ID", "unknown")
    parent_goal = ""

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == "--agent-type":
            i += 1
            agent_type = sys.argv[i]
        elif arg == "--task":
            i += 1
            task_description = sys.argv[i]
        elif arg == "--level":
            i += 1
            level = sys.argv[i]
        elif arg == "--triggers":
            i += 1
            triggers = sys.argv[i].split(",")
        elif arg == "--session":
            i += 1
            parent_session = sys.argv[i]
        elif arg == "--goal":
            i += 1
            parent_goal = sys.argv[i]
        i += 1

    preamble = build_preamble(
        agent_type=agent_type,
        task_description=task_description,
        parent_session=parent_session,
        parent_goal=parent_goal,
        level=level,
        triggers=triggers,
    )

    if preamble:
        print(preamble)
    else:
        print("[No Playbook manifest found — sub-agent inherits no structured context]")


if __name__ == "__main__":
    main()
