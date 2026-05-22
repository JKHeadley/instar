---
title: Job Scheduler
description: Cron-based task execution with priority levels and model tiering.
---

Define tasks as JSON with cron schedules. Instar spawns Claude Code sessions to execute them.

## Job Definition

```json
{
  "slug": "check-emails",
  "name": "Email Check",
  "schedule": "0 */2 * * *",
  "priority": "high",
  "enabled": true,
  "execute": {
    "type": "prompt",
    "value": "Check email for new messages. Summarize anything urgent and send to Telegram."
  }
}
```

## Job Types

| Type | Description |
|------|-------------|
| `prompt` | Spawns a Claude Code (or Codex) session with the given prompt |
| `script` | Runs a shell command |
| `skill` | Executes a slash command |
| `agentmd` | Resolves to `.instar/jobs/<origin>/<slug>.md` whose markdown body is the job spec. Lets job definitions live as full markdown files with YAML frontmatter instead of inline JSON. The fourteen built-in default jobs ship as `agentmd` files. |

## Priority Levels

Jobs have `low`, `medium`, or `high` priority. Higher priority jobs are executed first when multiple jobs are due simultaneously.

## Model Tiering

Each job can specify a model:

- **opus** -- Complex reasoning, analysis, long-form work
- **sonnet** -- General tasks, moderate reasoning (default)
- **haiku** -- Quick checks, simple tasks, high-frequency jobs

```json
{
  "slug": "health-check",
  "schedule": "*/5 * * * *",
  "model": "haiku",
  "execute": {
    "type": "prompt",
    "value": "Run health diagnostics and report any issues."
  }
}
```

## Supervision tiers

Jobs declare a `supervision` field that controls how each step is validated:

- **`tier0`** — Raw programmatic. No LLM validation. Fast, cheap, silent failures.
- **`tier1`** — LLM-supervised. A lightweight model (Haiku) validates each step. Observed failures.
- **`tier2`** — Full intelligent. A capable model (Sonnet/Opus) handles reasoning end-to-end. Handled failures.

The supervision tier is independent of the execution model — `tier1` may use Haiku for validation while the job runs on Sonnet, for instance. See [`docs/LLM-SUPERVISED-EXECUTION.md`](https://github.com/JKHeadley/instar/blob/main/docs/LLM-SUPERVISED-EXECUTION.md) for the design.

## Quota-aware backpressure

The scheduler reads from a shared `QuotaTracker` and shedds load tier-aware as quota tightens. Configure via `scheduler.quotaThresholds`:

| Bucket | Action |
|------|------|
| normal | Full scheduling |
| elevated | Defer Opus-tier jobs |
| critical | Defer Sonnet-tier jobs as well |
| shutdown | Pause everything except `health-check` |

This lets you keep critical safety jobs alive even when you're hammering against the daily cap. See the [observability page](/features/observability#quota-tracking) for how the underlying quota tracker works.

## Wake-time job reaper

When the host wakes from sleep, the scheduler reaps any pending runs older than `wakeReaper.thresholdMultiplier × expectedDurationMinutes`. This prevents a stampede of overdue jobs from firing all at once after a long suspend.

## Gate retries

Job gates (preconditions evaluated before the job body runs) can fail transiently. The scheduler retries gates up to `gateRetries` times (default 3) with `gateRetryDelayMs` between attempts (default 5 s). Persistent gate failures surface as a degradation rather than a stuck job.

## Default jobs

Instar ships fourteen built-in jobs that install on `instar init` and refresh on every update. See the [default jobs reference](/reference/default-jobs) for the complete list with schedules and supervision tiers.

## Legacy quota helper

Older agents may have enabled quota tracking via `instar add quota`. The new path is automatic — quota awareness is built into the scheduler and consults the `QuotaTracker` directly, no opt-in required.

## Managing Jobs

```bash
# Add a job
instar job add --slug daily-summary --name "Daily Summary" \
  --schedule "0 9 * * *" --priority medium

# List jobs
curl localhost:4040/jobs

# Trigger a job manually
curl -X POST localhost:4040/jobs/daily-summary/trigger \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN'
```

## Telegram Topics

Each job gets its own topic in your Telegram group. Job output is posted to its topic automatically, creating a living dashboard of agent activity.
