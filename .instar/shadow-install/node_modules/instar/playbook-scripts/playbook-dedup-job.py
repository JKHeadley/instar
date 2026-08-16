#!/usr/bin/env python3
"""
Playbook Deduplication Job — scheduled orchestration of dedup pipeline.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 4.8 Cycle 2).

Wraps the existing playbook-dedup.py module into a scheduled job with:
  - Per-category similarity tuning (lessons: 0.92, strategies: 0.85)
  - Dry-run mode enforcement for first 4 weeks (check governance date)
  - Human review requirement for identity/safety/infrastructure merges
  - Reporting and logging

Usage:
    python3 playbook-dedup-job.py run [--dry-run] [--force]
    python3 playbook-dedup-job.py status

Library usage:
    from playbook_dedup_job import run_dedup_job
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
GOVERNANCE_FILE = _paths.governance
DEDUP_JOB_LOG = os.path.join(PROJECT_DIR, "context-dedup-job-log.jsonl")

# Per-category similarity thresholds
CATEGORY_THRESHOLDS = {
    "lesson": 0.92,
    "strategy": 0.85,
    "infrastructure": 0.92,
    "domain": 0.90,
}

# Default dry-run enforcement period (4 weeks from first run)
DRY_RUN_WEEKS = 4


def _import_dedup():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "playbook_dedup",
        os.path.join(SCRIPT_DIR, "playbook-dedup.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_governance():
    if not os.path.exists(GOVERNANCE_FILE):
        return None
    with open(GOVERNANCE_FILE, "r") as f:
        return json.load(f)


def _get_first_run_date():
    """Get the date of the first dedup job run (for dry-run enforcement)."""
    if not os.path.exists(DEDUP_JOB_LOG):
        return None
    try:
        with open(DEDUP_JOB_LOG, "r") as f:
            first_line = f.readline().strip()
            if first_line:
                entry = json.loads(first_line)
                return entry.get("timestamp", "")
    except (json.JSONDecodeError, OSError):
        pass
    return None


def is_dry_run_enforced():
    """
    Check if dry-run mode is still enforced.

    Mandatory dry-run for first 4 weeks of operation.
    """
    first_run = _get_first_run_date()
    if not first_run:
        return True  # First run — enforce dry run

    try:
        from datetime import datetime, timezone, timedelta
        ts = first_run.replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        cutoff = dt + timedelta(weeks=DRY_RUN_WEEKS)
        now = datetime.now(timezone.utc)
        return now < cutoff
    except (ValueError, TypeError):
        return True


def _check_requires_human_review(duplicates, manifest):
    """
    Check if any duplicate pairs involve items requiring human review.

    Identity/safety/infrastructure merges need human review.
    """
    items_by_id = {}
    for item in manifest.get("items", []):
        items_by_id[item["id"]] = item

    review_required = []
    auto_approved = []

    for dup in duplicates:
        existing_item = items_by_id.get(dup["existing"], {})
        dup_item = items_by_id.get(dup["duplicate"], {})
        categories = {existing_item.get("category", ""), dup_item.get("category", "")}

        needs_review = categories & {"identity", "safety", "infrastructure"}
        if needs_review:
            review_required.append({
                "pair": dup,
                "reason": f"Category requires human review: {needs_review}",
            })
        else:
            auto_approved.append(dup)

    return auto_approved, review_required


def run_dedup_job(dry_run=None, force=False):
    """
    Run the deduplication job.

    If dry_run is None, uses enforcement logic (mandatory dry-run for 4 weeks).
    """
    dedup = _import_dedup()

    # Determine dry-run state
    enforced_dry_run = is_dry_run_enforced()
    if dry_run is None:
        dry_run = enforced_dry_run
    elif not dry_run and enforced_dry_run and not force:
        return {
            "status": "dry_run_enforced",
            "message": f"Dry-run mode enforced for first {DRY_RUN_WEEKS} weeks. Use --force to override.",
        }

    # Run the scan
    result = dedup.scan_duplicates(dry_run=True)  # Always scan in dry-run first

    if result.get("status") == "error":
        return result

    if result.get("status") == "clean":
        log_entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "clean",
            "items_scanned": result.get("items_scanned", 0),
            "dry_run": dry_run,
        }
        atomic_append(DEDUP_JOB_LOG, json.dumps(log_entry, separators=(",", ":")))
        return result

    # Process duplicates
    duplicates = result.get("duplicates", [])

    # Load manifest for category checking
    manifest = dedup._load_manifest()
    auto_approved, review_required = _check_requires_human_review(duplicates, manifest)

    # If not dry-run, submit auto-approved merges
    submitted = []
    if not dry_run and auto_approved:
        proposed = dedup.propose_merges(auto_approved, dry_run=False)
        submitted = proposed

    # Log
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "duplicates_found",
        "total_duplicates": len(duplicates),
        "auto_approved": len(auto_approved),
        "review_required": len(review_required),
        "submitted": len(submitted),
        "dry_run": dry_run,
        "enforced_dry_run": enforced_dry_run,
    }
    atomic_append(DEDUP_JOB_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "complete",
        "total_duplicates": len(duplicates),
        "auto_approved": len(auto_approved),
        "review_required": len(review_required),
        "submitted": len(submitted),
        "dry_run": dry_run,
        "enforced_dry_run": enforced_dry_run,
        "review_items": review_required,
    }


def job_status():
    """Get current dedup job status."""
    entries = []
    if os.path.exists(DEDUP_JOB_LOG):
        with open(DEDUP_JOB_LOG, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass

    return {
        "total_runs": len(entries),
        "dry_run_enforced": is_dry_run_enforced(),
        "first_run": _get_first_run_date(),
        "last_run": entries[-1] if entries else None,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "run":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        force = "--force" in sys.argv
        result = run_dedup_job(
            dry_run=dry_run if dry_run else None,
            force=force)
        print(json.dumps(result, indent=2))

    elif cmd == "status":
        result = job_status()
        print(json.dumps(result, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
