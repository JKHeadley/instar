---
title: Default Jobs
description: The fourteen built-in jobs that give your agent its circadian rhythm.
---

Instar ships with fourteen default jobs that run automatically on schedule. Each gives your agent a different rhythm: short-period health and commitment checks, mid-range reflection and evolution, daily identity reviews, and continuous oversight across development, learning, infrastructure, maintenance, and guardian responsibilities.

## Job schedule

| Job | Cron | Model | Purpose |
|-----|------|-------|---------|
| `health-check` | `*/5 * * * *` (every 5 min) | Haiku | Verify infrastructure health |
| `commitment-detection` | `*/5 * * * *` (every 5 min) | Haiku | Detect new commitments in the recent conversation flow |
| `reflection-trigger` | `0 */4 * * *` (every 4h) | Opus | Reflect on recent work and surface insights |
| `evolution-overdue-check` | `0 */4 * * *` (every 4h) | Haiku | Surface overdue commitments and stalled action items |
| `evolution-proposal-evaluate` | `0 */6 * * *` (every 6h) | Sonnet | Evaluate evolution proposals against current goals |
| `evolution-proposal-implement` | `0 1,7,13,19 * * *` (4× daily) | Opus | Implement evolution proposals that passed evaluation |
| `overseer-guardian` | `0 */6 * * *` (every 6h) | Sonnet | Guardian oversight — safety, alignment, value drift |
| `insight-harvest` | `0 */8 * * *` (every 8h) | Opus | Synthesize learnings into evolution proposals |
| `overseer-infrastructure` | `0 6 * * *` (daily 6am) | Haiku | Infrastructure oversight — quotas, health, scheduled work |
| `overseer-development` | `0 8 * * *` (daily 8am) | Haiku | Development oversight — open work, blockers, follow-through |
| `relationship-maintenance` | `0 9 * * *` (daily 9am) | Haiku | Review stale relationships, refresh significance scoring |
| `overseer-maintenance` | `0 2 * * *` (daily 2am) | Sonnet | Maintenance oversight — log rotation, cleanup, hygiene |
| `identity-review` | `0 3 * * *` (daily 3am) | Opus | Identity review — AGENT.md drift, value alignment |
| `overseer-learning` | `0 3 */2 * *` (every other day 3am) | Sonnet | Learning oversight — knowledge consolidation, gap detection |
| `docs-coverage-audit` | `0 10 * * 1` (Mondays 10am) | Haiku | Weekly walk of the instar source tree against the docs surface, surfaces newly-undocumented capabilities. Ships `enabled: false` by default; only useful on machines with the instar source repo locally |
| `org-intent-drift-audit` | (configurable) | Sonnet | Periodic drift detection for organizational intent — compares recent decisions and outputs against the constraints and goals declared in `ORG-INTENT.md`, surfaces drift via the degradation channel |

All jobs ship inside `src/scaffold/templates/jobs/instar/` and are installed on `instar init` plus refreshed on every update via `PostUpdateMigrator`.

## Supervision tiers

Jobs declare a `supervision` field that controls how each step is validated:

- **`tier0`** — Raw programmatic. No LLM validation. Fast, cheap, silent failures.
- **`tier1`** — LLM-supervised. A lightweight model (typically Haiku) validates each step. Observed failures.
- **`tier2`** — Full intelligent. A capable model (Sonnet or Opus) handles reasoning end-to-end. Handled failures.

The supervision tier is independent of the execution model — `tier1` may use Haiku while the job runs on Sonnet, for instance. See [`docs/LLM-SUPERVISED-EXECUTION.md`](https://github.com/JKHeadley/instar/blob/main/docs/LLM-SUPERVISED-EXECUTION.md) for the full design.

## Quota-aware backpressure

The scheduler reads from a shared `QuotaTracker` and shedds load as quota tightens. Threshold buckets in `scheduler.quotaThresholds`:

- **normal** — full scheduling
- **elevated** — defer Opus-tier jobs
- **critical** — defer Sonnet-tier jobs as well
- **shutdown** — pause everything except `health-check`

Tier-aware shedding lets you keep critical safety jobs alive even when you're hammering against your daily cap.

## Wake-time reaper

When the host wakes from sleep, the scheduler reaps any pending runs older than `wakeReaper.thresholdMultiplier × expectedDurationMinutes`. This prevents a stampede of overdue jobs from firing all at once after a long suspend.

## Gate retries

Job gates (preconditions evaluated before the job body runs) can fail transiently. The scheduler retries gates up to `gateRetries` times (default 3) with `gateRetryDelayMs` between attempts (default 5 s). Persistent gate failures surface as a degradation rather than a stuck job.

## Customization

Edit `.instar/jobs.json` (or the per-job `.md` files under `.instar/jobs/instar/` if your agent uses the newer agentmd execution type) to:

- Change schedules
- Adjust models
- Add new jobs
- Disable jobs you don't need

The agent can also modify its own jobs through the [evolution system](/features/evolution).

## The agentmd execution type

A newer execution type, `agentmd`, lets the job body live in the markdown frontmatter of `.instar/jobs/<origin>/<slug>.md` rather than inline in `jobs.json`. The fourteen built-in jobs ship as `agentmd` files under `src/scaffold/templates/jobs/instar/`, which is why you'll find them as markdown files rather than JSON entries.

## Superseded jobs

These older jobs still exist in some agent installations for backward compatibility but are disabled by default:

| Job | Replaced by |
|-----|------------|
| `update-check` | [AutoUpdater](/features/autoupdater) (built-in server component — no session needed) |
| `dispatch-check` | AutoDispatcher (built-in server component — no session needed) |

Both replacements are server-side components that don't spawn Claude sessions, saving quota.
