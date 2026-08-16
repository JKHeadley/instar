---
name: degradation-digest
description: Read DegradationReporter events, group repeated patterns, and escalate trends that need attention
metadata:
  user_invocable: "false"
---

# Degradation Digest — Pattern Detection for Failing Features

## Purpose

Review degradation events logged by the DegradationReporter, group repeated patterns, and escalate trends that indicate a primary path is reliably failing and needs fixing.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

### 1. Read Events

```
cat .instar/state/degradation-events.json
```

### 2. Check Previous Digest

```
cat .instar/state/job-handoff-degradation-digest.md 2>/dev/null
```

Compare against the previous digest to identify new patterns vs. already-reported ones.

### 3. Group by Feature

Count how many times each feature has degraded since the last digest.

### 4. Escalate Patterns

For each feature with **3+ repeated degradations** — this is a PATTERN, not a one-off. The primary path is reliably failing.

Submit feedback for each pattern:

```
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/feedback \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"Repeated degradation: FEATURE","description":"FEATURE has degraded N times. Primary: X. Fallback: Y. Most recent reason: Z. This pattern indicates the primary path needs fixing."}'
```

### 5. Write Handoff Notes

```
echo "Last digest: $(date -u +%Y-%m-%dT%H:%M:%SZ). Events by feature: ..." > .instar/state/job-handoff-degradation-digest.md
```

### 6. Exit Silently if Clean

If no patterns found (all one-offs), exit with no output.
