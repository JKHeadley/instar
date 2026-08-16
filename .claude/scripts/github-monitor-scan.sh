#!/usr/bin/env bash
# GitHub Collaboration Monitor — Stage 1 Scanner
# Gathers GitHub activity data and outputs it for classification.
# Called by the github-collab-monitor job's Haiku session.

set -euo pipefail

REPO="JKHeadley/instar"
STATE_DIR="$(dirname "$0")/../../.instar/state"
TRACKER_FILE="$STATE_DIR/github-monitor-tracker.json"
HANDOFF_FILE="$STATE_DIR/github-monitor-handoff.json"
AUDIT_DIR="$(dirname "$0")/../../.instar/logs"

# Ensure directories exist
mkdir -p "$STATE_DIR" "$AUDIT_DIR"

# Initialize tracker if missing
if [ ! -f "$TRACKER_FILE" ]; then
  echo '{"processedItems":{},"lastScanTime":"","version":1}' > "$TRACKER_FILE"
fi

# Pre-flight: check gh auth
if ! gh auth status 2>/dev/null | grep -q "Logged in"; then
  echo "ERROR: gh not authenticated"
  exit 1
fi

# Pre-flight: check rate limit
REMAINING=$(gh api rate_limit --jq '.rate.remaining' 2>/dev/null || echo "0")
if [ "$REMAINING" -lt 100 ]; then
  echo "ERROR: GitHub API rate limit low ($REMAINING remaining). Deferring scan."
  exit 1
fi

# Check kill switch
if [ -f "$STATE_DIR/../github-monitor-paused" ]; then
  echo "PAUSED: GitHub monitor is paused (sentinel file exists)"
  exit 0
fi

echo "=== GitHub Activity Scan ==="
echo "Repository: $REPO"
echo "API quota remaining: $REMAINING"
echo ""

# Gather data
echo "--- OPEN PRs ---"
gh pr list --repo "$REPO" --state open --json number,title,author,headRefOid,updatedAt,isDraft,labels,additions,deletions,changedFiles,statusCheckRollup 2>/dev/null || echo "[]"
echo ""

echo "--- RECENTLY MERGED PRs (last 10) ---"
gh pr list --repo "$REPO" --state merged --limit 10 --json number,title,author,mergedAt,headRefOid 2>/dev/null || echo "[]"
echo ""

echo "--- OPEN ISSUES ---"
gh issue list --repo "$REPO" --state open --json number,title,author,comments,updatedAt,labels 2>/dev/null || echo "[]"
echo ""

echo "--- FORKS ---"
gh api "repos/$REPO/forks?per_page=100&sort=newest" --jq '.[] | {owner: .owner.login, full_name: .full_name, pushed_at: .pushed_at, created_at: .created_at, stargazers_count: .stargazers_count}' 2>/dev/null || echo "[]"
echo ""

echo "--- CURRENT TRACKER STATE ---"
cat "$TRACKER_FILE"
echo ""

echo "--- COLLABORATORS ---"
gh api "repos/$REPO/collaborators" --jq '.[].login' 2>/dev/null || echo "none"
echo ""

echo "=== END SCAN DATA ==="
