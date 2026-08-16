---
name: session-continuity-check
description: Verify that sessions produce lasting artifacts like handoff notes, memory updates, and learnings
metadata:
  user_invocable: "false"
---

# Session Continuity Check — Artifact Production Verification

## Purpose

Check whether recent sessions contributed to long-term knowledge. Detects continuity leaks where knowledge is generated but not preserved.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

### 1. Recent Sessions

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/sessions
```

Get sessions that completed in the last 8 hours.

### 2. Job Session Artifacts

For each completed job session, check:
- Does a handoff note exist? (`.instar/state/job-handoff-{slug}.md`)
- Was it updated recently? (stat or date check)
- If the job is reflection-trigger or insight-harvest, did MEMORY.md actually change? (Check git diff or file modification time)

### 3. Interactive Session Artifacts

For non-job sessions, check:
- Did the session produce any lasting artifacts? (git log for commits, MEMORY.md changes, new files in .instar/)
- If a long session (>10 minutes) left no trace, that's a continuity leak — knowledge was generated but not preserved.

### 4. Handoff Note Freshness

```
ls -la .instar/state/job-handoff-*.md
```

- Any handoff note older than 7 days for an active job? It might contain stale claims.
- Flag stale handoff notes as potential misinformation vectors.

## Output

- If sessions are running but not producing artifacts: propose an evolution to improve the reflection-trigger or add post-session hooks
- If handoff notes are stale: add a "[STALE]" prefix to the file so the next job session treats it with appropriate skepticism

Write handoff:

```
echo "Continuity check at $(date). Sessions reviewed: N. Artifacts found: N. Gaps: N." > .instar/state/job-handoff-session-continuity-check.md
```

Exit silently if continuity is healthy.
