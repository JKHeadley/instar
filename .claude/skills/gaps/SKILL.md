---
name: gaps
description: Report a capability gap — something you need but don't have.
metadata:
  user_invocable: "true"
---

# /gaps

Report a capability gap. Use this when you discover something you should be able to do but can't — a missing skill, knowledge area, integration, or workflow that would make you more effective.

## Steps

1. **Describe the gap** — What were you trying to do? What's missing?
2. **Classify it**:
   - `skill` — Missing ability (e.g., can't parse a specific format)
   - `knowledge` — Missing information (e.g., don't know how a system works)
   - `integration` — Missing connection (e.g., can't talk to a service)
   - `workflow` — Missing process (e.g., no standard way to do X)
   - `communication` — Missing voice capability (e.g., can't express X well)
   - `monitoring` — Missing observability (e.g., can't detect when X happens)
3. **Assess severity** (critical/high/medium/low)
4. **Describe current state** — What do you do instead? What's the workaround?
5. **Propose a solution** if you have one
6. **Submit**:

```bash
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/gaps \
  -H 'Content-Type: application/json' \
  -d '{"title":"TITLE","category":"CATEGORY","severity":"medium","description":"WHAT_IS_MISSING","context":"WHEN_DID_YOU_NOTICE","currentState":"CURRENT_WORKAROUND","proposedSolution":"HOW_TO_FIX"}'
```

## When to Use

- When you can't fulfill a user request and have to say "I can't do that yet"
- When you notice yourself repeatedly working around a limitation
- When an integration you need doesn't exist
- When you lack knowledge about a system you interact with
- When monitoring would catch an issue before it becomes a problem

## View Current Gaps

```bash
curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/gaps
```
