#!/usr/bin/env python3
"""
Instar Telemetry Collector — Tracks npm downloads, GitHub metrics, and stores
historical data for trend analysis.

Collects:
  - npm download stats (daily, weekly, monthly)
  - GitHub repo stats (stars, forks, clones, views, issues)
  - Computed trends (week-over-week changes)

Outputs:
  - Appends snapshot to {state_dir}/telemetry.jsonl
  - Writes latest summary to {state_dir}/telemetry-latest.json
  - Prints human-readable summary to stdout

Usage:
  python3 scripts/collect-metrics.py [--state-dir DIR] [--json] [--quiet]
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_STATE_DIR = os.path.expanduser("~/.instar/telemetry")


def run_cmd(cmd, timeout=30):
    """Run a shell command and return stdout, or None on failure."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def fetch_npm_downloads():
    """Fetch npm download stats for the 'instar' package."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    ranges = {
        "last_day": "last-day",
        "last_week": "last-week",
        "last_month": "last-month",
    }

    stats = {}
    for key, period in ranges.items():
        raw = run_cmd(["curl", "-sf", f"https://api.npmjs.org/downloads/point/{period}/instar"])
        if raw:
            try:
                data = json.loads(raw)
                stats[key] = data.get("downloads", 0)
            except json.JSONDecodeError:
                stats[key] = None
        else:
            stats[key] = None

    # Also get daily breakdown for last 7 days
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    raw = run_cmd(["curl", "-sf", f"https://api.npmjs.org/downloads/range/{week_ago}:{today}/instar"])
    if raw:
        try:
            data = json.loads(raw)
            stats["daily_breakdown"] = [
                {"date": d["day"], "downloads": d["downloads"]}
                for d in data.get("downloads", [])
            ]
        except json.JSONDecodeError:
            stats["daily_breakdown"] = []

    return stats


def fetch_github_metrics():
    """Fetch GitHub repo stats using gh CLI."""
    metrics = {}

    # Repo stats
    raw = run_cmd(["gh", "api", "repos/SageMindAI/instar", "--jq",
                    '{stars: .stargazers_count, forks: .forks_count, open_issues: .open_issues_count, watchers: .subscribers_count}'])
    if raw:
        try:
            metrics["repo"] = json.loads(raw)
        except json.JSONDecodeError:
            metrics["repo"] = None

    # Clone traffic (last 14 days)
    raw = run_cmd(["gh", "api", "repos/SageMindAI/instar/traffic/clones", "--jq",
                    '{total: .count, unique: .uniques}'])
    if raw:
        try:
            metrics["clones_14d"] = json.loads(raw)
        except json.JSONDecodeError:
            metrics["clones_14d"] = None

    # View traffic (last 14 days)
    raw = run_cmd(["gh", "api", "repos/SageMindAI/instar/traffic/views", "--jq",
                    '{total: .count, unique: .uniques}'])
    if raw:
        try:
            metrics["views_14d"] = json.loads(raw)
        except json.JSONDecodeError:
            metrics["views_14d"] = None

    # Referral sources
    raw = run_cmd(["gh", "api", "repos/SageMindAI/instar/traffic/popular/referrers"])
    if raw:
        try:
            referrers = json.loads(raw)
            metrics["top_referrers"] = [
                {"source": r["referrer"], "count": r["count"], "uniques": r["uniques"]}
                for r in referrers[:5]
            ]
        except json.JSONDecodeError:
            metrics["top_referrers"] = []

    return metrics


def compute_trends(state_dir):
    """Compare current metrics to previous snapshots for trend detection."""
    history_file = Path(state_dir) / "telemetry.jsonl"
    if not history_file.exists():
        return None

    # Read last 7 entries
    lines = history_file.read_text().strip().split("\n")
    recent = []
    for line in lines[-7:]:
        try:
            recent.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    if len(recent) < 2:
        return None

    prev = recent[-2] if len(recent) >= 2 else None
    week_ago = recent[0] if len(recent) >= 7 else recent[0]

    trends = {}
    if prev:
        prev_npm = prev.get("npm", {}).get("last_day")
        trends["npm_day_prev"] = prev_npm

    if week_ago:
        week_npm = week_ago.get("npm", {}).get("last_week")
        trends["npm_week_prev"] = week_npm

    return trends


def save_snapshot(snapshot, state_dir):
    """Append snapshot to JSONL history and write latest summary."""
    state_path = Path(state_dir)
    state_path.mkdir(parents=True, exist_ok=True)

    # Append to history
    history_file = state_path / "telemetry.jsonl"
    with open(history_file, "a") as f:
        f.write(json.dumps(snapshot) + "\n")

    # Write latest
    latest_file = state_path / "telemetry-latest.json"
    with open(latest_file, "w") as f:
        json.dump(snapshot, f, indent=2)


def format_summary(snapshot):
    """Format a human-readable summary."""
    lines = []
    ts = snapshot.get("timestamp", "unknown")
    lines.append(f"Instar Telemetry Snapshot — {ts}")
    lines.append("=" * 50)

    npm = snapshot.get("npm", {})
    lines.append(f"\nnpm Downloads:")
    lines.append(f"  Last 24h:  {npm.get('last_day', '?'):>8,}")
    lines.append(f"  Last 7d:   {npm.get('last_week', '?'):>8,}")
    lines.append(f"  Last 30d:  {npm.get('last_month', '?'):>8,}")

    gh = snapshot.get("github", {})
    repo = gh.get("repo", {})
    if repo:
        lines.append(f"\nGitHub Repo:")
        lines.append(f"  Stars:     {repo.get('stars', '?'):>8}")
        lines.append(f"  Forks:     {repo.get('forks', '?'):>8}")
        lines.append(f"  Issues:    {repo.get('open_issues', '?'):>8}")

    clones = gh.get("clones_14d", {})
    if clones:
        lines.append(f"\nGit Clones (14d):")
        lines.append(f"  Total:     {clones.get('total', '?'):>8,}")
        lines.append(f"  Unique:    {clones.get('unique', '?'):>8,}")

    views = gh.get("views_14d", {})
    if views:
        lines.append(f"\nPage Views (14d):")
        lines.append(f"  Total:     {views.get('total', '?'):>8}")
        lines.append(f"  Unique:    {views.get('unique', '?'):>8}")

    referrers = gh.get("top_referrers", [])
    if referrers:
        lines.append(f"\nTop Referrers:")
        for r in referrers:
            lines.append(f"  {r['source']:<25} {r['count']:>5} ({r['uniques']} unique)")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Collect Instar telemetry metrics")
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help="Directory for telemetry data")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of human-readable")
    parser.add_argument("--quiet", action="store_true", help="No stdout output (just save)")
    args = parser.parse_args()

    snapshot = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "collector_version": "1.0.0",
    }

    # Collect
    snapshot["npm"] = fetch_npm_downloads()
    snapshot["github"] = fetch_github_metrics()
    snapshot["trends"] = compute_trends(args.state_dir)

    # Save
    save_snapshot(snapshot, args.state_dir)

    # Output
    if not args.quiet:
        if args.json:
            print(json.dumps(snapshot, indent=2))
        else:
            print(format_summary(snapshot))

    return 0


if __name__ == "__main__":
    sys.exit(main())
