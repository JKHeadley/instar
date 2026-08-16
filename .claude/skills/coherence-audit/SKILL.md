---
name: coherence-audit
description: Verify topic-project bindings, project map freshness, canonical state files, and context segments are healthy
metadata:
  user_invocable: "false"
---

# Coherence Audit — Awareness Infrastructure Health Check

## Purpose

Verify that the agent's awareness infrastructure is healthy: topic bindings point to real directories, the project map is fresh, state files parse correctly, and context segments are present.

## Procedure

Read the auth token once:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

Check each area:

### 1. Topic-Project Bindings

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/topic-bindings
```

- Are all bindings still valid?
- Do the project directories they point to actually exist on disk?
- Flag any bindings pointing to missing directories.

### 2. Project Map Freshness

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/project-map
```

- Check the `generatedAt` timestamp.
- If older than 24 hours, trigger a refresh: `POST /project-map/refresh`
- A stale map means job 11 (project-map-refresh) may be failing.

### 3. Canonical State Files

Check these files exist and are parseable JSON:
- `.instar/quick-facts.json`
- `.instar/anti-patterns.json`
- `.instar/project-registry.json`

Flag any that are missing, empty, or contain invalid JSON. Look for stale entries that reference things that no longer exist.

### 4. Context Segments

```
curl -s -H "Authorization: Bearer $AUTH" http://localhost:${INSTAR_PORT:-4042}/context
```

- Are all expected segments present?
- Are any segments 0 bytes (empty)?
- Missing context segments mean behavioral instructions may be lost.

## On Issues Found

- Log findings as evolution learnings: `POST /evolution/learnings`
- Fix what can be fixed automatically (e.g., refresh a stale map, remove broken bindings)
- Exit silently if everything is healthy — no output means no problems
