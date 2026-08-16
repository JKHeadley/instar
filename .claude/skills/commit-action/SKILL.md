---
name: commit-action
description: Create a tracked action item — a commitment with follow-through tracking.
metadata:
  user_invocable: "true"
---

# /commit-action

Create a tracked action item. Use this when you promise to do something, identify a task that needs follow-through, or want to ensure something doesn't fall through the cracks.

## Steps

1. **Define the action** — What needs to be done? Be specific and actionable.
2. **Set priority** (critical/high/medium/low)
3. **Set a due date** if applicable (ISO 8601 format)
4. **Identify who/what you're committing to** (optional)
5. **Submit**:

```bash
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/evolution/actions \
  -H 'Content-Type: application/json' \
  -d '{"title":"TITLE","description":"WHAT_TO_DO","priority":"medium","dueBy":"2026-03-01T00:00:00Z","commitTo":"WHO_OR_WHAT","tags":["tag1"]}'
```

6. **When complete**, mark it done:

```bash
curl -s -X PATCH http://localhost:${INSTAR_PORT:-4042}/evolution/actions/ACT-XXX \
  -H 'Content-Type: application/json' \
  -d '{"status":"completed","resolution":"What was done"}'
```

## When to Use

- When you promise a user you'll follow up on something
- When you identify a task during work that shouldn't be forgotten
- When a learning or gap requires a specific action
- When you need to check back on something later
- When committing to implement an evolution proposal

## View Actions

```bash
# All pending actions
curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/actions?status=pending

# Overdue actions
curl -s http://localhost:${INSTAR_PORT:-4042}/evolution/actions/overdue
```

## The Commitment Check

The commitment-check job runs every 4 hours and surfaces overdue items. If you create an action and forget it, the system won't.
