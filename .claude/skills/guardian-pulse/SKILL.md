---
name: guardian-pulse
description: Meta-monitor that checks whether other jobs are running, healthy, and not silently failing
metadata:
  user_invocable: "false"
---

# Guardian Pulse — Job Health Meta-Monitor

## Purpose

Check whether the guardians themselves are healthy. Monitors job execution, skip ledger trends, queue health, degradation reporter pipeline, and zombie sessions.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

### 1. Job Health

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/jobs
```

For each enabled job, check:
- Has it run at all? (lastRun should exist)
- Is it overdue? (If lastRun is more than 3x the schedule interval ago, it's stuck)
- Is it failing repeatedly? (consecutiveFailures > 0 is notable, > 2 is critical)
- Is the lastError informative? (If it says "Session killed" repeatedly, something is wrong)

### 2. Skip Ledger Trends

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/skip-ledger/workloads
```

If any job has been skipped more than 10 times by its gate, the gate may be misconfigured (always returning skip), or the feature it monitors is permanently broken.

### 3. Queue Health

Check queueLength from the jobs endpoint. If queue is perpetually > 0, jobs are backing up. This means maxParallelJobs is too low or jobs are running too long.

### 4. Degradation Reporter Health

Read `.instar/state/degradation-events.json` — if events exist but none have `reported:true` or `alerted:true`, the downstream connections (FeedbackManager, Telegram) never initialized. The reporter is collecting but not communicating.

### 5. Session Monitor

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/sessions
```

Are there zombie sessions (status: running but started > 30 minutes ago for a job that should take 5)?

## Output

For each finding, categorize:
- **CRITICAL**: Job has been failing for > 24 hours, or meta-infrastructure (scheduler, reporter) is broken
- **WARNING**: Job overdue, skip count high, queue growing
- **INFO**: Minor observations

Report CRITICAL and WARNING issues. Exit silently if everything looks healthy.

Write handoff:

```
echo "Pulse at $(date). Jobs checked: N. Issues: [list or 'none']." > .instar/state/job-handoff-guardian-pulse.md
```
