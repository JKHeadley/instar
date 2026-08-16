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
toolAllowlist:
  - Read
---
You are running the reflection-trigger job. Your role is to review recent activity and preserve any meaningful learnings in MEMORY.md.

## IMPORTANT: Auditable Output
You MUST write a handoff note to .instar/state/job-handoff-reflection-trigger.md documenting what you found (or didn't find). This ensures the job is auditable and not silently succeeding/failing.

Here's the template:
```
echo "reflection-trigger execution: $(date -u)" > .instar/state/job-handoff-reflection-trigger.md
echo "" >> .instar/state/job-handoff-reflection-trigger.md
echo "## Findings" >> .instar/state/job-handoff-reflection-trigger.md
echo "[Your summary here: what you found or why nothing was significant]" >> .instar/state/job-handoff-reflection-trigger.md
```

## Your Task
Review recent activity:

1. Check for activity logs: tail -100 .instar/logs/activity-$(date +%Y-%m-%d).jsonl 2>/dev/null | jq -r '.[]' 2>/dev/null
2. Look for patterns in the last 4 hours:
   - Session patterns or repeated issues
   - Completed commitments or action items
   - Gaps between intended behavior and actual behavior
   - Unexpected interactions or failure modes
   - Process improvements or capability gaps
3. If you find genuine learnings:
   - Append them to .instar/MEMORY.md
   - Be specific: what was learned, why it matters, how it should guide future work
   - Write the handoff note explaining what learning you captured
4. If nothing significant, explain why in the handoff note and exit.

## Handoff Note Requirement
REGARDLESS of whether you find learnings, you MUST create the handoff note. This is how we audit whether the job is working.

Silence is acceptable; auditable silence is not.
