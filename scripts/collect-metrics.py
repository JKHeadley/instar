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

SPIKE_THRESHOLD = 2.0  # Alert if current is > 2x previous


def send_telegram_alert(message: str) -> bool:
    """Send a Telegram alert to Justin via Dawn Server. Returns True if successful."""
    try:
        result = subprocess.run(
            ["python3", os.path.expanduser(".claude/scripts/telegram-send.py"), message, "--silent"],
            cwd=os.path.expanduser("~/Documents/Projects/the-portal"),
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"Warning: Failed to send Telegram alert: {e}", file=sys.stderr)
        return False


def detect_significant_changes(current_snapshot: dict, state_dir: str) -> dict:
    """Compare current metrics to previous snapshot and detect significant changes."""
    changes = {}

    history_file = Path(state_dir) / "telemetry.jsonl"
    if not history_file.exists():
        return changes

    # Read last entry (previous snapshot)
    try:
        lines = history_file.read_text().strip().split("\n")
        if not lines:
            return changes
        prev_snapshot = json.loads(lines[-1])
    except (json.JSONDecodeError, IndexError):
        return changes

    # Check if npm data is stale (not published for today/yesterday)
    current_end_date = current_snapshot.get("npm", {}).get("end_date")
    prev_end_date = prev_snapshot.get("npm", {}).get("end_date")

    # Skip spike detection if data hasn't changed since last run
    if current_end_date and prev_end_date and current_end_date == prev_end_date:
        changes["npm_stale"] = {
            "end_date": current_end_date,
            "message": f"npm data unpublished since {current_end_date}; skipping spike comparison",
        }
        return changes

    # Compare npm downloads only if data is fresh
    current_npm = current_snapshot.get("npm", {}).get("last_day")
    prev_npm = prev_snapshot.get("npm", {}).get("last_day")

    if current_npm and prev_npm and prev_npm > 0:
        ratio = current_npm / prev_npm
        if ratio > SPIKE_THRESHOLD:
            changes["npm_spike"] = {
                "previous": prev_npm,
                "current": current_npm,
                "ratio": round(ratio, 2),
                "end_date": current_end_date,
            }

    return changes


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
    npm_end_date = None  # Track when npm data is published up to
    for key, period in ranges.items():
        raw = run_cmd(["curl", "-sf", f"https://api.npmjs.org/downloads/point/{period}/instar"])
        if raw:
            try:
                data = json.loads(raw)
                stats[key] = data.get("downloads", 0)
                # Capture end date from the API response
                if key == "last_day" and "end" in data:
                    npm_end_date = data["end"]
            except json.JSONDecodeError:
                stats[key] = None
        else:
            stats[key] = None

    # Store the end date so we can detect stale data
    stats["end_date"] = npm_end_date

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

    # recent[-1] is the most recent snapshot (previous day)
    # recent[0] is the oldest of the 7 (approximately 1 week ago)
    prev = recent[-1] if len(recent) >= 2 else None
    week_ago = recent[0] if len(recent) >= 7 else recent[0]

    trends = {}
    if prev:
        prev_npm = prev.get("npm", {}).get("last_day")
        prev_npm_end = prev.get("npm", {}).get("end_date")
        trends["npm_day_prev"] = prev_npm
        if prev_npm_end:
            trends["npm_day_prev_end_date"] = prev_npm_end

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
    if npm.get("end_date"):
        lines.append(f"  Data published through: {npm.get('end_date')}")

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
    parser.add_argument("--no-alerts", action="store_true", help="Skip Telegram alerts (dryrun mode)")
    args = parser.parse_args()

    snapshot = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "collector_version": "1.0.0",
    }

    # Collect
    snapshot["npm"] = fetch_npm_downloads()
    snapshot["github"] = fetch_github_metrics()
    snapshot["trends"] = compute_trends(args.state_dir)

    # Detect significant changes (before saving)
    changes = detect_significant_changes(snapshot, args.state_dir)
    snapshot["alerts_sent"] = []
    snapshot["change_notes"] = []

    # Track stale data
    if "npm_stale" in changes:
        snapshot["change_notes"].append(f"⚠️ {changes['npm_stale']['message']}")

    # Send alerts for significant changes
    if changes and not args.no_alerts:
        if "npm_spike" in changes:
            spike = changes["npm_spike"]
            alert_msg = (
                f"🎯 Instar npm spike detected!\n"
                f"Previous 24h: {spike['previous']} downloads\n"
                f"Current 24h: {spike['current']} downloads\n"
                f"Change: +{(spike['ratio'] - 1) * 100:.0f}% ({spike['ratio']}x)"
            )
            if send_telegram_alert(alert_msg):
                snapshot["alerts_sent"].append("npm_spike_telegram")

    # Save
    save_snapshot(snapshot, args.state_dir)

    # Output
    if not args.quiet:
        if args.json:
            print(json.dumps(snapshot, indent=2))
        else:
            summary = format_summary(snapshot)
            if snapshot.get("alerts_sent"):
                summary += f"\n\n✅ Alerts sent: {', '.join(snapshot['alerts_sent'])}"
            print(summary)

    return 0


if __name__ == "__main__":
    sys.exit(main())
