---
name: evolve
description: Propose an evolution improvement to your own infrastructure, behavior, or capabilities.
metadata:
  user_invocable: "true"
---

# /evolve

Propose an evolution improvement. Use this when you identify something about yourself that could be better — a new capability, a workflow improvement, a behavioral pattern worth encoding, or infrastructure worth building.

## Steps

1. **Identify the improvement** — What did you notice? What triggered this? Be specific.
2. **Classify it**:
   - `capability` — New skill or ability
   - `infrastructure` — System improvement (hooks, jobs, scripts)
   - `voice` — Communication or tone improvement
   - `workflow` — Process improvement
   - `philosophy` — Principle or value update
   - `integration` — New external connection
   - `performance` — Speed or efficiency improvement
3. **Assess impact and effort** (high/medium/low for each)
4. **Submit the proposal**:

```bash
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/proposals \
  -H 'Content-Type: application/json' \
  -d '{"title":"TITLE","source":"WHERE_YOU_NOTICED","description":"WHAT_AND_WHY","type":"TYPE","impact":"medium","effort":"medium"}'
```

5. **Check the dashboard** for context:

```bash
curl -s http://localhost:${INSTAR_PORT:-4042}/evolution
```

## When to Use

- After completing a task in a way that felt unnecessarily difficult
- When you notice a pattern you keep repeating manually
- When a user request reveals a capability you should have but don't
- When you find yourself working around a limitation
- After reading about a technique or pattern that would improve your work

## Philosophy

Evolution is not a separate activity from work — it IS the work. Every task is an opportunity to notice what could be better. The best proposals come from real experience, not abstract planning.
