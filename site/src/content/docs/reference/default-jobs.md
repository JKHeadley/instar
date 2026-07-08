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
| `mentor-onboarding` | `*/15 * * * *` (every 15m) | Haiku | Framework-Onboarding Mentor heartbeat — a thin timer that pokes `POST /mentor/tick`; the in-process tick runs a leak-detector canary, a fail-closed budget gate, a safe-window check, a constrained Stage-A spawn, the leakage detector, Stage-B forensics, and ledger capture. Ships `enabled: false` and `mentor.mode: 'off'`; dormant until promoted off → dry-run → live |
| `failure-analyzer` | `0 9 * * 3` (Wednesdays 9am) | Haiku | Failure-Learning Loop analyzer — weekly scan of the failure ledger for dev-process patterns. Surfaces support-and-diversity-thresholded insights, opens human-approved tracked improvements (never auto-implements), and runs the verify step on past fixes. Tier-1 supervised (wraps the deterministic `/failures/analyze` endpoint, validating each insight against its evidence). Ships `enabled: false`; turns on with `monitoring.failureLearning.enabled` |
| `initiative-digest-review` | `0 11 * * 1,4` (Mon & Thu 11am) | Sonnet | The self-driving half of the InitiativeTracker — twice-weekly review of the initiative board. Surfaces initiatives that need a decision and, for ships-staged features in rollout (dry-run → live → default-on), gathers promotion evidence and posts an explicit, evidence-gated recommendation. Near-silent (posts only when a genuinely-new decision is waiting); operator-gated — it recommends, it never flips a config flag |
| `review-canary-battery` | `15 6 * * *` (daily 6:15am) | Haiku | Daily adversarial canary battery for the [context-aware outbound review](/architecture/context-aware-outbound-review) soak — drives one `ReviewCanaryBattery` run via the Bearer-gated `POST /review/canary-battery/run` trigger (seed booby-trapped fixtures into reserved negative topic ids → replay baseline + with-context arms → reviewer-level assertions → cleanup), proving the "user asked for this" carve-out cannot launder a credential/PII paste past the opted-in reviewer. Every outcome — including refusals — writes a `batterySummary` row, so a silent skip is impossible. Tier-1 supervised. Ships `enabled: false`; the operator enables it only on the soaking dev agent for the §D9 soak window |
| `bench-refresh` | `0 4 1 * *` (monthly, 1st 4am) | Haiku | [LLM routing benchmark](/features/llm-routing-bench) refresh — on the machine carrying the bench harness it reruns the benchmark + a parity-check and raises ONE operator-review diff when a routing default looks stale. Never auto-applies a routing change; no-ops on any machine without the harness. Tier-1 supervised. Ships `enabled: false`; enable only on a maintainer machine |
| `doorway-scan` | `0 4 * * 1` (Mondays 4am) | Haiku | Doorway/Model Knowledge Registry live re-probe — a deterministic prober (`scripts/doorway-scan.mjs`) probes each doorway (which CLIs / free model-list APIs answer, and which top models each exposes), updates the per-machine live scan-state, diffs against the previous scan, and raises ONE jargon-safe operator diff with only the changes. Free probes by default (zero metered spend); never auto-edits the canonical registry. `perMachineIndependent` (each machine scans its own disk). Tier-1 supervised. Ships `enabled: false`; enable only on a maintainer machine |
| `routing-price-refresh` | `0 5 * * 1` (Mondays 5am) | Haiku | Routing Control Room spend view (Increment A) price refresh — a deterministic prober (`scripts/routing-price-refresh.mjs`) re-confirms published per-token prices for the metered routing doors from PUBLIC, no-auth model-list endpoints (OpenRouter) at the free scope, validates each price (range + cached≤input + UTC day-alignment), and writes forward-only points into the MACHINE-LOCAL observed cache (`.instar/routing-prices.observed.json`) ONLY — structurally never the canonical price manifest. Observed points feed the read-only spend view + a promote-me drift hint; they are gate-ineligible by construction. Metered/web-verify probes are manual-only + budget-fail-closed. `perMachineIndependent`. Tier-1 supervised. Ships `enabled: false`; enable only on a maintainer machine |
| `routing-price-web-verify` | `0 6 * * 2` (Tuesdays 6am) | Haiku | The SCHEDULED web-research price check (operator directive 2026-07-07) for the metered doors whose prices live on OFFICIAL WEB PAGES only (Groq, Google): the same deterministic prober at `--scope +web-verify` fetches groq.com/pricing + ai.google.dev/pricing, extracts tracked-model prices with conservative fail-closed parsers (fixture-realness-tested — a reshaped page refuses, never guesses) plus a >10x plausibility clamp vs the reviewed canonical price, and writes forward-only OBSERVATIONS into the machine-local observed cache only. Zero spend (no LLM, no metered key). An observed price never becomes official without the operator's PIN promotion. `perMachineIndependent`. Tier-1 supervised. Ships `enabled: false` |

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
