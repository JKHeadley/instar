#!/usr/bin/env python3
"""
Playbook Context Effectiveness Dashboard — real-time pipeline health view.

Part of Playbook Phase 2 (context-engineering-integration spec).

Generates a dashboard showing:
  - Manifest health (items, categories, usefulness scores)
  - Assembly effectiveness (load rates, budget usage)
  - Pipeline status (pending reviews, rejected deltas, chain health)
  - Eval-log coverage (sessions with micro-evals)
  - Phase gate status (known bugs)

Usage:
    python3 playbook-dashboard.py                # Print dashboard to stdout
    python3 playbook-dashboard.py --json         # Machine-readable output
    python3 playbook-dashboard.py --save         # Save to dashboard file

Library usage:
    from playbook_dashboard import generate_dashboard
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
DASHBOARD_FILE = os.path.join(_paths.project_root, "docs", "research", "portal",
                              "dashboards", "PLAYBOOK_DASHBOARD.md")


def _import_baseline_metrics():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_baseline_metrics",
        os.path.join(SCRIPT_DIR, "playbook-baseline-metrics.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_failsafe():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_failsafe",
        os.path.join(SCRIPT_DIR, "playbook-failsafe.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_lifecycle():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_lifecycle",
        os.path.join(SCRIPT_DIR, "playbook-lifecycle.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _import_tests():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_tests",
        os.path.join(SCRIPT_DIR, "playbook-tests.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def generate_dashboard_data():
    """Collect all dashboard metrics."""
    metrics = _import_baseline_metrics()
    snapshot, _ = metrics.capture_metrics()

    # Chain health
    chain_health = "unknown"
    try:
        failsafe = _import_failsafe()
        status = failsafe.failsafe_status()
        chain_health = status.get("overall", "unknown")
    except Exception:
        pass

    # Lifecycle status
    lifecycle_status = {}
    try:
        lifecycle = _import_lifecycle()
        lifecycle_status = lifecycle.lifecycle_status()
    except Exception:
        pass

    # Known bugs
    known_bugs = []
    try:
        tests = _import_tests()
        known_bugs = tests.KNOWN_BUGS
    except Exception:
        pass

    # Pending review count
    pending_dir = os.path.join(PROJECT_DIR, "context-pending-review")
    pending_count = 0
    if os.path.exists(pending_dir):
        pending_count = len([f for f in os.listdir(pending_dir) if f.endswith(".json")])

    return {
        "timestamp": snapshot["timestamp"],
        "manifest": snapshot["manifest"],
        "history": snapshot["history"],
        "assembly": snapshot["assembly"],
        "pipeline": snapshot["pipeline"],
        "eval_log": snapshot["eval_log"],
        "chain_health": chain_health,
        "lifecycle": lifecycle_status,
        "known_bugs": known_bugs,
        "pending_review_count": pending_count,
    }


def render_dashboard_markdown(data):
    """Render dashboard data as markdown."""
    m = data.get("manifest", {})
    h = data.get("history", {})
    a = data.get("assembly", {})
    p = data.get("pipeline", {})
    e = data.get("eval_log", {})
    lc = data.get("lifecycle", {})

    lines = []
    lines.append("# Playbook Context Effectiveness Dashboard")
    lines.append(f"\n**Generated**: {data['timestamp']}")
    lines.append(f"**Chain Health**: {data['chain_health']}")

    # Phase gate
    bugs = data.get("known_bugs", [])
    if bugs:
        lines.append(f"\n## PHASE GATE: BLOCKED ({len(bugs)} known bugs)")
        for b in bugs:
            lines.append(f"- [{b['id']}] {b['description']}")
    else:
        lines.append("\n## Phase Gate: CLEAR")

    # Manifest
    lines.append("\n## Manifest")
    lines.append(f"- **Total items**: {m.get('total_items', 0)}")
    lines.append(f"- **Schema version**: {m.get('schema_version', '?')}")
    lines.append(f"- **Last lifecycle run**: {m.get('last_lifecycle_run', 'never')}")
    lines.append(f"- **Avg usefulness ratio**: {m.get('avg_usefulness_ratio', 0)}")
    lines.append("\n| Category | Count |")
    lines.append("|----------|-------|")
    for cat, count in sorted(m.get("by_category", {}).items()):
        lines.append(f"| {cat} | {count} |")

    # Assembly
    lines.append("\n## Assembly")
    lines.append(f"- **Total assemblies**: {a.get('total_assemblies', 0)}")
    lines.append(f"- **Avg items selected**: {a.get('avg_items_selected', 0)}")
    lines.append(f"- **Avg budget usage**: {a.get('avg_budget_usage_pct', 0)}%")

    if a.get("trigger_distribution"):
        lines.append("\n| Trigger | Count |")
        lines.append("|---------|-------|")
        for trigger, count in sorted(a["trigger_distribution"].items(), key=lambda x: -x[1]):
            lines.append(f"| {trigger} | {count} |")

    # Pipeline
    lines.append("\n## Pipeline")
    lines.append(f"- **Deltas submitted**: {p.get('total_deltas_submitted', 0)}")
    lines.append(f"- **Deltas applied**: {p.get('total_deltas_applied', 0)}")
    lines.append(f"- **Deltas rejected**: {p.get('total_deltas_rejected', 0)}")
    lines.append(f"- **Pending review**: {data.get('pending_review_count', 0)}")

    # History
    lines.append("\n## History")
    lines.append(f"- **Chain length**: {h.get('total_entries', 0)} entries")
    if h.get("operations"):
        lines.append("\n| Operation | Count |")
        lines.append("|-----------|-------|")
        for op, count in sorted(h["operations"].items(), key=lambda x: -x[1]):
            lines.append(f"| {op} | {count} |")

    # Eval-Log
    lines.append("\n## Eval-Log Coverage")
    lines.append(f"- **Sessions with evals**: {e.get('sessions_with_evals', 0)}")
    lines.append(f"- **Total micro-evals**: {e.get('total_micro_evals', 0)}")
    lines.append(f"- **Total session-evals**: {e.get('total_session_evals', 0)}")

    # Lifecycle
    if lc:
        lines.append("\n## Lifecycle Status")
        lines.append(f"- **Pending deltas**: {lc.get('pending', 0)}")
        lock = lc.get("lock", {})
        lines.append(f"- **Lock held**: {lock.get('exists', False)}")
        if lock.get("stale"):
            lines.append("- **STALE LOCK DETECTED**")

    return "\n".join(lines)


def generate_dashboard(save=False, json_output=False):
    """Generate and optionally save the dashboard."""
    data = generate_dashboard_data()

    if json_output:
        return json.dumps(data, indent=2)

    md = render_dashboard_markdown(data)

    if save:
        os.makedirs(os.path.dirname(DASHBOARD_FILE), exist_ok=True)
        with open(DASHBOARD_FILE, "w") as f:
            f.write(md)
        return md, DASHBOARD_FILE

    return md


def main():
    save = "--save" in sys.argv
    json_output = "--json" in sys.argv

    result = generate_dashboard(save=save, json_output=json_output)

    if save and isinstance(result, tuple):
        md, filepath = result
        print(md)
        print(f"\nSaved to: {filepath}")
    else:
        print(result)


if __name__ == "__main__":
    main()
