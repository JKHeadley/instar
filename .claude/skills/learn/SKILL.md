---
name: learn
description: Record a learning or insight in the structured learning registry.
metadata:
  user_invocable: "true"
---

# /learn

Record a learning or insight. Use this when you discover something worth remembering — a pattern, a solution, a mistake, or an observation that future sessions should know about.

## Steps

1. **Identify the learning** — What did you discover? What's the actionable insight?
2. **Categorize it** (e.g., debugging, architecture, user-preference, integration, communication, workflow)
3. **Tag it** for searchability
4. **Submit**:

```bash
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/learnings \
  -H 'Content-Type: application/json' \
  -d '{"title":"TITLE","category":"CATEGORY","description":"FULL_INSIGHT","source":{"discoveredAt":"DATE","platform":"WHERE","session":"SESSION_ID"},"tags":["tag1","tag2"]}'
```

5. **If it suggests an improvement**, note the evolution relevance:
   - Add `"evolutionRelevance": "This could become a skill/hook/job because..."`
   - The insight-harvest job will pick this up and potentially create a proposal

## When to Use

- After solving a tricky problem (capture the solution pattern)
- After a user interaction reveals a preference you didn't know
- After discovering a tool or technique that works well
- After making a mistake (capture what went wrong and the fix)
- After noticing a pattern across multiple tasks

## Difference from MEMORY.md

MEMORY.md is your personal scratchpad — unstructured, read by you.
The learning registry is structured, searchable, and connected to the evolution system.
Use MEMORY.md for quick notes. Use /learn for insights that should influence future behavior.
