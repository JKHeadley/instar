#!/usr/bin/env python3
"""
Playbook Offline Adaptation — bootstrap manifest from session history.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 8.1 Stage 4).

ACE's "offline adaptation" concept: process 2,200+ session reports to extract
recurring strategies and bootstrap usefulness counters from historical outcomes.

Scans session reports for:
  1. Recurring strategies mentioned across multiple sessions
  2. Tool/pattern usage frequency (evidence of usefulness)
  3. Error patterns that led to lessons

Usage:
    python3 playbook-offline-adapt.py scan [--limit N]     # Scan session reports
    python3 playbook-offline-adapt.py extract               # Extract strategies
    python3 playbook-offline-adapt.py migrate [--dry-run]   # Generate deltas

Library usage:
    from playbook_offline_adapt import scan_session_reports, extract_strategies
"""

import hashlib
import json
import os
import re
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")
MANIFEST_FILE = _paths.manifest
ADAPTATION_LOG = os.path.join(PROJECT_DIR, "context-adaptation-log.jsonl")


def _load_manifest():
    if not os.path.exists(MANIFEST_FILE):
        return None
    with open(MANIFEST_FILE, "r") as f:
        return json.load(f)


def _read_session_report(session_dir):
    """Read a session report file and extract key sections."""
    report_path = os.path.join(session_dir, "report.md")
    if not os.path.exists(report_path):
        return None

    try:
        with open(report_path, "r", errors="replace") as f:
            content = f.read()
        return {
            "session_id": os.path.basename(session_dir),
            "content": content,
            "path": report_path,
        }
    except OSError:
        return None


def scan_session_reports(limit=None):
    """
    Scan all session reports for patterns.

    Returns summary of sessions found and basic statistics.
    """
    if not os.path.exists(SESSIONS_DIR):
        return {"status": "error", "message": f"Sessions directory not found: {SESSIONS_DIR}"}

    reports = []
    session_dirs = sorted([
        d for d in os.listdir(SESSIONS_DIR)
        if os.path.isdir(os.path.join(SESSIONS_DIR, d))
        and d.startswith("AUT-")
    ])

    if limit:
        session_dirs = session_dirs[-limit:]

    for dirname in session_dirs:
        session_path = os.path.join(SESSIONS_DIR, dirname)
        report = _read_session_report(session_path)
        if report:
            reports.append(report)

    return {
        "status": "complete",
        "total_session_dirs": len([
            d for d in os.listdir(SESSIONS_DIR)
            if os.path.isdir(os.path.join(SESSIONS_DIR, d))
        ]),
        "reports_found": len(reports),
        "reports": reports,
    }


def extract_strategies(reports=None, limit=None):
    """
    Extract recurring strategies from session reports.

    Looks for:
    - Patterns mentioned in 3+ sessions (likely important)
    - Technical solutions with verifiable outcomes
    - Domain-specific knowledge
    """
    if reports is None:
        scan = scan_session_reports(limit=limit)
        if scan.get("status") == "error":
            return scan
        reports = scan.get("reports", [])

    if not reports:
        return {"status": "no_reports", "strategies": []}

    # Extract text patterns
    pattern_counts = {}
    pattern_sessions = {}

    # Strategy extraction patterns
    strategy_patterns = [
        # "When X, do Y" patterns
        re.compile(r'(?:when|if)\s+(.{20,80}?),\s+(?:do|use|try|run|set)\s+(.{10,80})', re.IGNORECASE),
        # "X requires Y" patterns
        re.compile(r'(.{10,50}?)\s+(?:requires?|needs?|must have)\s+(.{10,80})', re.IGNORECASE),
        # "Always/Never X" patterns
        re.compile(r'(?:always|never)\s+(.{10,100})', re.IGNORECASE),
        # "Fix: X" or "Solution: X" patterns
        re.compile(r'(?:fix|solution|workaround|resolved?)\s*:\s*(.{20,150})', re.IGNORECASE),
    ]

    for report in reports:
        content = report.get("content", "")
        session_id = report.get("session_id", "")

        for pattern in strategy_patterns:
            matches = pattern.findall(content)
            for match in matches:
                if isinstance(match, tuple):
                    text = " ".join(match).strip()
                else:
                    text = match.strip()

                # Normalize
                text_key = re.sub(r'\s+', ' ', text.lower())[:100]
                if len(text_key) < 20:
                    continue

                pattern_counts[text_key] = pattern_counts.get(text_key, 0) + 1
                pattern_sessions.setdefault(text_key, set()).add(session_id)

    # Filter to patterns appearing in 2+ sessions (lowered from 3 for Phase 3)
    recurring = []
    for text_key, count in sorted(pattern_counts.items(), key=lambda x: -x[1]):
        sessions = pattern_sessions.get(text_key, set())
        if len(sessions) >= 2:
            recurring.append({
                "text": text_key,
                "occurrences": count,
                "sessions": sorted(sessions),
                "session_count": len(sessions),
            })

    return {
        "status": "complete",
        "reports_analyzed": len(reports),
        "patterns_found": len(pattern_counts),
        "recurring_strategies": len(recurring),
        "strategies": recurring[:100],  # Cap at 100
    }


def generate_migration_deltas(strategies=None, dry_run=True, limit=None):
    """
    Generate manifest deltas from extracted strategies.

    Creates "strategy" category items with bootstrap counters based on
    occurrence frequency.
    """
    import secrets

    if strategies is None:
        result = extract_strategies(limit=limit)
        if result.get("status") != "complete":
            return result
        strategies = result.get("strategies", [])

    if not strategies:
        return {"status": "no_strategies", "message": "No strategies to migrate"}

    # Load manifest for dedup check
    manifest = _load_manifest()
    existing_texts = set()
    if manifest:
        for item in manifest.get("items", []):
            inline = item.get("content_inline", "").lower()
            if inline:
                existing_texts.add(inline[:100])

    deltas = []
    skipped = 0

    for idx, strategy in enumerate(strategies):
        text = strategy["text"]

        # Skip if similar content exists
        if text[:100] in existing_texts:
            skipped += 1
            continue

        # Generate item ID
        words = re.sub(r'[^a-z0-9\s]', '', text.lower()).split()
        slug = "-".join(words[:4]) if words else f"strategy-{idx}"
        item_id = f"/context/strategies/adapted/{slug}"

        content_hash = "sha256:" + hashlib.sha256(text.encode()).hexdigest()[:16]

        delta = {
            "delta_id": f"delta-{secrets.token_hex(6)}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_session": "OFFLINE_ADAPT",
            "operation": "create",
            "target_item_id": item_id,
            "reflector_confidence": min(0.6 + strategy["session_count"] * 0.05, 0.90),
            "payload": {
                "category": "strategy",
                "memory_type": "experiential",
                "content_inline": text[:2000],
                "content_hash": content_hash,
                "tokens_est": len(text) // 4 + 1,
                "tags": {"domains": [], "qualifiers": []},
                "load_triggers": [],
            },
            "evidence": [{
                "type": "test_result",
                "value": f"offline_adapt:occurrences={strategy['occurrences']},sessions={strategy['session_count']}",
            }],
        }
        deltas.append(delta)

    # Submit if not dry run
    if not dry_run and deltas:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "playbook_lifecycle",
                os.path.join(SCRIPT_DIR, "playbook-lifecycle.py"))
            lifecycle = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(lifecycle)
            for delta in deltas:
                lifecycle.submit_delta(delta)
        except Exception as e:
            return {"status": "error", "message": f"Failed to submit: {e}"}

    # Log
    from atomic_write import atomic_append
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "strategies_found": len(strategies),
        "deltas_created": len(deltas),
        "skipped_dedup": skipped,
        "dry_run": dry_run,
    }
    atomic_append(ADAPTATION_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "complete",
        "strategies_input": len(strategies),
        "deltas_created": len(deltas),
        "skipped_dedup": skipped,
        "dry_run": dry_run,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        limit = None
        if "--limit" in sys.argv:
            idx = sys.argv.index("--limit")
            limit = int(sys.argv[idx + 1])
        result = scan_session_reports(limit=limit)
        print(f"Sessions found: {result.get('total_session_dirs', 0)}")
        print(f"Reports readable: {result.get('reports_found', 0)}")

    elif cmd == "extract":
        limit = None
        if "--limit" in sys.argv:
            idx = sys.argv.index("--limit")
            limit = int(sys.argv[idx + 1])
        result = extract_strategies(limit=limit)
        print(f"Reports analyzed: {result.get('reports_analyzed', 0)}")
        print(f"Recurring strategies: {result.get('recurring_strategies', 0)}")
        for s in result.get("strategies", [])[:10]:
            print(f"  [{s['session_count']} sessions] {s['text'][:80]}...")

    elif cmd == "migrate":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        limit = None
        if "--limit" in sys.argv:
            idx = sys.argv.index("--limit")
            limit = int(sys.argv[idx + 1])
        result = generate_migration_deltas(dry_run=dry_run, limit=limit)
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
