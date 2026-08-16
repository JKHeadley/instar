---
name: memory-hygiene
description: Review MEMORY.md for stale entries, duplicates, and quality issues — propose cleanup
metadata:
  user_invocable: "false"
---

# Memory Hygiene — MEMORY.md Quality Review

## Purpose

Review `.instar/MEMORY.md` for quality and hygiene. Memory is identity — stale or noisy entries actively mislead future sessions. This job keeps memory clean, consolidated, and actionable.

## Procedure

Read the auth token:

```
AUTH=$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('authToken',''))" 2>/dev/null)
```

Read the full file: `cat .instar/MEMORY.md`

Evaluate each entry against these criteria:

### 1. Staleness

Does this entry reference files, APIs, URLs, or features that no longer exist? Verify by checking if referenced paths exist (`ls`, `curl`). Stale entries actively mislead future sessions.

### 2. Duplicates

Are multiple entries saying the same thing in different words? Consolidate them into a single, stronger entry.

### 3. Abstraction Without Substance

Does the entry say something concrete and actionable, or is it a vague platitude?

- **Good:** "The /api/chat endpoint caches responses for 5 minutes — bypass with ?nocache=1"
- **Bad:** "Remember to check caching behavior."

### 4. Size Check

Count total words. If MEMORY.md exceeds 5000 words, it's becoming a burden on context rather than an aid. Identify the bottom 20% by usefulness and propose removing them.

### 5. Organization

Are entries grouped by topic? Is the structure navigable? Reorganize if needed.

## On Issues Found

- Fix duplicates and minor cleanups directly (edit the file)
- For significant deletions, add a comment `PROPOSED REMOVAL: [reason]` rather than deleting — let the next reflection-trigger or human confirm
- Log a learning if you discover a pattern:

```
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/learnings \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"category":"memory","insight":"...","confidence":"high"}'
```

## Handoff

Write handoff notes:

```
echo "Last hygiene: $(date). Words: N. Entries: N. Removed: N. Flagged: N." > .instar/state/job-handoff-memory-hygiene.md
```

If MEMORY.md is clean and well-organized, exit silently.
