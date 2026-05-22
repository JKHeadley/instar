---
title: Weekly docs-coverage audit job + CI workflow
slug: docs-coverage-weekly
status: ratified
approved: true
review-convergence: 2026-05-22T03:25:00Z
eli16-overview: docs-coverage-weekly.eli16.md
ratification: principal-direct-2026-05-21
ratification-evidence: Telegram topic 11235, item 6 of the autonomous-mode instruction ("establish a once a week job that performs the exact work we have done here so that we can keep the docs/readme up to date continuously as we continue to develop instar"). Companion to the docs-coverage spec (`docs/specs/docs-coverage.md`) — same authority.
---

# Weekly docs-coverage audit job + CI workflow

## Problem

The docs-coverage script and per-PR CI gate (shipped in the docs-coverage spec) prevent regression on a per-PR basis but don't surface accumulated drift between contributors who haven't touched the gate. If three contributors each ship features that each individually scrape past the floor (because the floor is loose during the transition period), coverage can stagnate at the floor indefinitely. We need a periodic check that surfaces the trend, not just the per-PR floor.

## Design

Two complementary delivery surfaces:

### Job template (off by default)

`src/scaffold/templates/jobs/instar/docs-coverage-audit.md` — an `agentmd` job that runs every Monday at 10:00 local time, locates the instar source repo on the running machine, executes the coverage script, compares to the previous week's baseline, and surfaces interesting deltas via Telegram in plain conversational language.

Defaults to `enabled: false` because most agent installations don't have the instar source repo locally — running this on a customer-owned agent would just send "no instar repo found" every Monday. The instar-developing agent (Echo, or any other instar-dev agent) can flip the flag in `.instar/jobs/instar/docs-coverage-audit.md` to enable it.

Distribution: ships via the normal `installBuiltinJobs()` path, so existing agents pick it up on the next update via `PostUpdateMigrator`. No separate migration needed because `installBuiltinJobs()` already overwrites built-in template files on every update.

### CI workflow (always on)

`.github/workflows/docs-coverage-weekly.yml` — a GitHub Actions cron workflow that runs every Monday at 10:00 UTC against the main branch. Executes the coverage script, uploads the JSON + markdown reports as workflow artifacts, and posts the report as a comment on a standing tracking issue (creating the issue on first run, then appending to it weekly).

This is the structural safety net — runs regardless of whether any developer or agent is paying attention. Even if every instar-developing agent forgets to enable the job, the CI workflow surfaces the trend in a place (a GitHub issue) where it can be reviewed and acted on.

## Why both

The job surface gives an instar-developing agent the data in the medium they actually work in (Telegram, conversationally). The CI workflow gives the project a durable record (a GitHub issue) that anyone can review. They overlap but the redundancy is intentional — neither alone catches every failure mode, and they have different blast radii if they break.

## Cadence

Weekly is the right cadence because the underlying gap is large enough that daily would be noise (coverage doesn't change that fast) but monthly would let a sprint's worth of drift accumulate before surfacing. Monday morning means contributors see the report at the start of the week when they have the most planning flexibility.

## What the job does NOT do

It surfaces drift, it does not fix it. The job's instructions explicitly say "this is a guardian job, not a doer" — the fix work belongs in a deliberate doc-update PR with proper review. An autonomous job that started writing docs on its own would either produce low-quality docs or get tangled in the spec gate that instar-dev work goes through. Better to surface the gap and let the human-driven loop close it.

## Rollback

Both surfaces are net-additive and trivially reversible:

- Remove `src/scaffold/templates/jobs/instar/docs-coverage-audit.md` — existing agents lose the template on the next update.
- Remove `.github/workflows/docs-coverage-weekly.yml` — the cron stops on next merge to main.

No data migration, no schema change.

## Non-goals

- **Replacing the per-PR CI gate.** The per-PR gate (in the docs-coverage spec) is for regression. The weekly audit is for trend.
- **Auto-fixing.** Discussed above.
- **Per-user notifications.** The job surfaces to Telegram; the workflow surfaces to a GitHub issue. Neither targets specific people. If we later want to route to a specific maintainer, that's a separate change.
