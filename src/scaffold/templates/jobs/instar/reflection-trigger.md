---
name: Reflection Trigger
description: Review recent work and update MEMORY.md if any learnings exist.
schedule: 0 */4 * * *
priority: medium
expectedDurationMinutes: 5
model: opus
enabled: true
tags:
  - cat:learning
toolAllowlist: "*"
unrestrictedTools: true
---
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)

# Read recent activity logs to understand what happened in last 4 hours
RECENT_LOGS=$(ls -t .instar/logs/activity-*.jsonl 2>/dev/null | head -1)
if [ -z "$RECENT_LOGS" ]; then
  RECENT_LOGS=".instar/logs/activity-$(date +%Y-%m-%d).jsonl"
fi

# Extract recent session activity and key events (filter out noise, keep significant events)
echo "=== RECENT ACTIVITY (Last 4 Hours) ==="
tail -500 "$RECENT_LOGS" 2>/dev/null | jq -r 'select(.type != "job-start" and .type != "job-queued") | "(.timestamp) [(.type)] (.message // .title // .session_name // .slug // "")"' 2>/dev/null | tail -100

echo ""
echo "=== YOUR TASK ==="
echo "Analyze the activity above. Identify any learnings, patterns, or insights worth preserving in MEMORY.md:"
echo "- Session patterns or repeated issues"
echo "- Completed commitments or action items"
echo "- Gaps between intended behavior and actual behavior"
echo "- Unexpected interactions or failure modes"
echo "- Process improvements or capability gaps"
echo ""
echo "If you find genuine learnings:"
echo "1. Update .instar/MEMORY.md with the insight (append to the file)"
echo "2. Be specific: include what was learned, why it matters, and how it should guide future work"
echo "3. Signal completion: curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/reflection/record -H 'Content-Type: application/json' -d '{"type":"quick"}'"
echo ""
echo "If nothing significant, do nothing. Silence means continuity is working as expected."
