---
name: state-integrity-check
description: Cross-validate state file consistency, detect orphaned references and bloat
metadata:
  user_invocable: "false"
---

# State Integrity Check — Cross-Validation of Agent State

## Purpose

Cross-validate agent state files for logical consistency. Detect orphaned references, bloated files, config-reality mismatches, and stale handoff notes. Fix what can be fixed automatically.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

### 1. Active Job Orphan

If `.instar/state/active-job.json` exists, verify the session it references is actually running:

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/sessions
```

Check if the session name matches. If the session is dead but active-job.json persists, it's orphaned — delete it.

### 2. Job-Topic Orphan

Read `.instar/state/job-topic-mappings.json`. For each mapping, verify the topic ID is reachable:

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/telegram/topics
```

If topics have been deleted, the mapping is stale — flag it.

### 3. State File Bloat

Check sizes of all state files. Any file over 1MB is a bloat signal. Common culprits:
- `degradation-events.json` growing unbounded
- Activity logs accumulating

Report bloated files and prune where safe.

### 4. Config-Reality Match

Read `.instar/config.json`. If Telegram is configured, verify the bot is connected:

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/health
```

Check if the telegram field shows connected. If config says telegram but health says disconnected, report the discrepancy.

### 5. Handoff Note Staleness

Check `.instar/state/job-handoff-*.md` files. If any are older than 7 days and reference state that may have changed, flag them as potentially stale.

## On Issues Found

- Submit feedback for each issue found
- Fix what you can automatically (delete orphaned active-job.json, prune bloated files)
- Exit silently if everything checks out — no output means no problems
