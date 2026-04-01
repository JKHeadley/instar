# Example: Multi-Job Agent

An Instar agent with multiple scheduled jobs, including a frequent health check and a regular work job.

## Files

### `.instar/jobs.json`

```json
[
  {
    "slug": "health-check",
    "name": "Health Check",
    "description": "Verify the agent environment is healthy before other work accumulates",
    "schedule": "*/30 * * * *",
    "priority": "high",
    "model": "haiku",
    "enabled": true,
    "execute": {
      "type": "prompt",
      "value": "Verify the project directory exists, check available disk space, and confirm outbound network connectivity. If anything looks unhealthy, report the issue clearly and suggest the next debugging step."
    }
  },
  {
    "slug": "daily-review",
    "name": "Daily Review",
    "description": "Review local work in progress and summarize what needs attention",
    "schedule": "0 10 * * 1-5",
    "priority": "medium",
    "model": "sonnet",
    "enabled": true,
    "grounding": {
      "requiresIdentity": true,
      "processesExternalInput": false,
      "contextFiles": [".instar/AGENT.md"]
    },
    "execute": {
      "type": "prompt",
      "value": "Review any uncommitted changes in the current project. Summarize what appears to be in progress, call out likely risks, and note the next concrete step to move the work forward."
    }
  }
]
```

## Setup

1. Run `instar init` in your project if you have not already done so
2. Copy this example to `.instar/jobs.json`
3. Make sure `.instar/AGENT.md` describes the agent that should run these jobs
4. Run `instar server start`
5. Watch the health check run frequently while the review job runs on a weekday schedule

## What This Example Demonstrates

- Multiple jobs in one agent with different schedules
- A health check pattern that catches environment issues early
- Priority ordering, where the health check is favored when multiple jobs queue together
- Model tiering, where a lightweight recurring check can use `haiku` while a deeper review job uses `sonnet`
- The current scheduler schema, where jobs declare `enabled` and an explicit `execute` block
- A minimal grounding declaration for work that should run in the agent's identity context

## Why The Jobs Differ

- `health-check` runs every 30 minutes with `high` priority so environment issues surface quickly
- `daily-review` runs once each weekday morning with `medium` priority because it represents routine work
- `health-check` uses `haiku` for a cheap, high-frequency probe while `daily-review` uses `sonnet` for a more thoughtful summary
- Both jobs use `execute.type: "prompt"` because the scheduler now expects an explicit execution mode instead of a top-level `prompt` field
- `daily-review` declares `grounding.requiresIdentity` so the example also reflects the scheduler's current grounding audit expectations

## Customization Ideas

- Add a third weekly maintenance job
- Lower the health check frequency if your environment is stable
- Change the review job prompt to match your team's recurring workflow

> **Full docs:** [Scheduler](https://instar.sh/features/scheduler/) · [Configuration](https://instar.sh/reference/configuration/)
