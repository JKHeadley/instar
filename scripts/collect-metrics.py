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
DROP_THRESHOLD = 0.6  # Alert if the current week is below 60% of the previous week
GAP_MIN_CONSECUTIVE = 2  # Alert on this many consecutive interior zero-download days


PORTAL_DIR_CANDIDATES = (
    os.environ.get("DAWN_PORTAL_DIR"),
    "~/Projects/the-portal",
    "~/Documents/Projects/the-portal",
)

TELEGRAM_SEND_REL = ".claude/scripts/telegram-send.py"


def resolve_portal_dir():
    """Locate the the-portal checkout that hosts telegram-send.py.

    ~/Documents is unreliable on this machine -- reads intermittently fail with
    EPERM since a macOS change in Oct 2026 -- and
    ~/Documents/Projects/the-portal is now only a symlink to
    ~/Projects/the-portal. Prefer the real path so an alert does not depend on
    the symlink resolving, and keep the old location as a last resort.
    """
    for candidate in PORTAL_DIR_CANDIDATES:
        if not candidate:
            continue
        path = Path(os.path.expanduser(candidate))
        if (path / TELEGRAM_SEND_REL).exists():
            return path
    return None


def send_telegram_alert(message: str) -> bool:
    """Send a Telegram alert to Justin via Dawn Server. Returns True if successful."""
    portal_dir = resolve_portal_dir()
    if portal_dir is None:
        print(
            "Warning: no the-portal checkout with "
            f"{TELEGRAM_SEND_REL} found; alert not sent",
            file=sys.stderr,
        )
        return False
    try:
        result = subprocess.run(
            ["python3", str(portal_dir / TELEGRAM_SEND_REL), message, "--silent"],
            cwd=str(portal_dir),
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            print(
                f"Warning: telegram-send exited {result.returncode}: "
                f"{(result.stderr or '').strip()[:200]}",
                file=sys.stderr,
            )
        return result.returncode == 0
    except Exception as e:
        print(f"Warning: Failed to send Telegram alert: {e}", file=sys.stderr)
        return False


def _is_number(value) -> bool:
    """True for a real numeric metric value (bools are not metrics)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _fmt_count(value, width: int = 8) -> str:
    """Right-align a count, tolerating a missing or non-numeric value.

    npm returns None for every metric when the fetch fails (observed on
    2026-04-16 and 2026-08-29). A ',' format spec raises on None and on the '?'
    placeholder alike, which crashed the whole summary on exactly the runs
    where the data was most worth looking at.
    """
    if _is_number(value):
        return f"{value:>{width},}"
    return f"{'?':>{width}}"


def _day_kind(entry) -> str:
    """Classify one daily_breakdown entry as 'zero', 'nonzero', or 'unknown'.

    'unknown' covers a missing or non-numeric count. An unknown day is never
    read as a zero, so a hole in the feed can never be reported as a gap.
    """
    downloads = entry.get("downloads") if isinstance(entry, dict) else None
    if not _is_number(downloads):
        return "unknown"
    return "zero" if downloads == 0 else "nonzero"


def find_interior_zero_runs(daily_breakdown, min_consecutive: int = GAP_MIN_CONSECUTIVE):
    """Find runs of consecutive zero-download days that have real traffic on BOTH sides.

    Only an interior run is a reporting gap. Leading zeros (the window opening
    before npm had data) and trailing zeros (npm's normal 1-2 day publishing
    lag) are expected and are NOT flagged -- otherwise every run would report a
    gap for the lag alone.

    Returns a list of {"start", "end", "days"} in window order.
    """
    days = [d for d in (daily_breakdown or []) if isinstance(d, dict)]
    kinds = [_day_kind(d) for d in days]
    runs = []
    index = 0
    while index < len(days):
        if kinds[index] != "zero":
            index += 1
            continue
        end = index
        while end + 1 < len(days) and kinds[end + 1] == "zero":
            end += 1
        length = end - index + 1
        traffic_before = "nonzero" in kinds[:index]
        traffic_after = "nonzero" in kinds[end + 1:]
        if length >= min_consecutive and traffic_before and traffic_after:
            runs.append({
                "start": days[index].get("date"),
                "end": days[end].get("date"),
                "days": length,
            })
        index = end + 1
    return runs


def detect_significant_changes(current_snapshot: dict, state_dir: str) -> dict:
    """Compare current metrics to the previous snapshot and detect significant changes.

    Detects, independently of one another:
      - npm_gap:   GAP_MIN_CONSECUTIVE+ consecutive interior zero-download days
      - npm_drop:  last_week below DROP_THRESHOLD x the previous run's last_week
      - npm_spike: last_day above SPIKE_THRESHOLD x the previous run's last_day
      - npm_stale: npm has published nothing new since the previous run

    Staleness skips only the SPIKE comparison. The drop and gap checks still
    run, because a stalled npm pipeline is one of the things that causes a week
    to collapse -- skipping them on stale data would hide the exact case they
    exist to catch (observed: the 2026-10-20..23 runs are all stale).
    """
    changes = {}

    current_npm_block = current_snapshot.get("npm") or {}
    current_end_date = current_npm_block.get("end_date")

    # The gap check reads only the current snapshot, so it needs no history.
    gap_runs = find_interior_zero_runs(current_npm_block.get("daily_breakdown"))
    if gap_runs:
        longest = max(gap_runs, key=lambda r: r["days"])
        changes["npm_gap"] = {
            "runs": gap_runs,
            "longest_days": longest["days"],
            "start": longest["start"],
            "end": longest["end"],
            "end_date": current_end_date,
        }

    history_file = Path(state_dir) / "telemetry.jsonl"
    if not history_file.exists():
        return changes

    # Read last entry (previous snapshot)
    try:
        lines = history_file.read_text().strip().split("\n")
        if not lines or not lines[0]:
            return changes
        prev_snapshot = json.loads(lines[-1])
    except (json.JSONDecodeError, IndexError):
        return changes

    prev_npm_block = prev_snapshot.get("npm") or {}
    prev_end_date = prev_npm_block.get("end_date")

    # Week-over-week drop. Safe to run on stale data: when npm has published
    # nothing new both runs carry the same last_week, so the ratio is 1.0.
    current_week = current_npm_block.get("last_week")
    prev_week = prev_npm_block.get("last_week")
    if _is_number(current_week) and _is_number(prev_week) and prev_week > 0:
        week_ratio = current_week / prev_week
        if week_ratio < DROP_THRESHOLD:
            changes["npm_drop"] = {
                "previous": prev_week,
                "current": current_week,
                "ratio": round(week_ratio, 2),
                "pct_change": round((week_ratio - 1) * 100, 1),
                "end_date": current_end_date,
            }

    # Skip the day-over-day spike comparison when npm has not published since
    # the previous run -- both snapshots would share the same last_day.
    if current_end_date and prev_end_date and current_end_date == prev_end_date:
        changes["npm_stale"] = {
            "end_date": current_end_date,
            "message": f"npm data unpublished since {current_end_date}; skipping spike comparison",
        }
        return changes

    current_npm = current_npm_block.get("last_day")
    prev_npm = prev_npm_block.get("last_day")

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


def build_change_notes(changes: dict) -> list:
    """Render detected changes as structured change notes.

    Each note carries a `kind` so a consumer can route on it without parsing
    prose, plus a `message` for the printed summary.
    """
    notes = []

    drop = changes.get("npm_drop")
    if drop:
        notes.append({
            "kind": "drop",
            "message": (
                f"npm weekly downloads fell {abs(drop['pct_change']):.0f}% "
                f"({drop['previous']:,} -> {drop['current']:,}) since the previous run"
            ),
            "previous": drop["previous"],
            "current": drop["current"],
            "ratio": drop["ratio"],
            "pct_change": drop["pct_change"],
        })

    gap = changes.get("npm_gap")
    if gap:
        spans = ", ".join(
            f"{r['start']}..{r['end']} ({r['days']}d)" for r in gap["runs"]
        )
        notes.append({
            "kind": "gap",
            "message": (
                f"npm reported {gap['longest_days']} consecutive zero-download days "
                f"inside the window: {spans}"
            ),
            "runs": gap["runs"],
            "longest_days": gap["longest_days"],
        })

    spike = changes.get("npm_spike")
    if spike:
        notes.append({
            "kind": "spike",
            "message": (
                f"npm daily downloads rose {(spike['ratio'] - 1) * 100:.0f}% "
                f"({spike['previous']:,} -> {spike['current']:,})"
            ),
            "previous": spike["previous"],
            "current": spike["current"],
            "ratio": spike["ratio"],
        })

    stale = changes.get("npm_stale")
    if stale:
        notes.append({
            "kind": "stale",
            "message": stale["message"],
            "end_date": stale["end_date"],
        })

    return notes


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

    # The point API's "end" lags the range API, which made fresh data read as
    # stale. Prefer the newest daily_breakdown day with downloads > 0.
    nonzero = [d["date"] for d in stats.get("daily_breakdown") or [] if d.get("downloads")]
    if nonzero:
        stats["end_date"] = max(nonzero)

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
    lines.append(f"  Last 24h:  {_fmt_count(npm.get('last_day'))}")
    lines.append(f"  Last 7d:   {_fmt_count(npm.get('last_week'))}")
    lines.append(f"  Last 30d:  {_fmt_count(npm.get('last_month'))}")
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
        lines.append(f"  Total:     {_fmt_count(clones.get('total'))}")
        lines.append(f"  Unique:    {_fmt_count(clones.get('unique'))}")

    views = gh.get("views_14d", {})
    if views:
        lines.append(f"\nPage Views (14d):")
        lines.append(f"  Total:     {views.get('total', '?'):>8}")
        lines.append(f"  Unique:    {views.get('unique', '?'):>8}")

    notes = snapshot.get("change_notes") or []
    if notes:
        lines.append(f"\nChange Notes:")
        for note in notes:
            if isinstance(note, dict):
                lines.append(f"  [{note.get('kind', 'note')}] {note.get('message', '')}")
            else:
                lines.append(f"  {note}")

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
    snapshot["change_notes"] = build_change_notes(changes)

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

        if "npm_drop" in changes:
            drop = changes["npm_drop"]
            alert_msg = (
                f"\U0001F4C9 Instar npm weekly downloads dropped\n"
                f"Previous 7d: {drop['previous']:,} downloads\n"
                f"Current 7d: {drop['current']:,} downloads\n"
                f"Change: {drop['pct_change']:.0f}% ({drop['ratio']}x)"
            )
            if send_telegram_alert(alert_msg):
                snapshot["alerts_sent"].append("npm_drop_telegram")

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
