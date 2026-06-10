## What Changed

Added Slice 3 (final layer) of the dev-agent dark-gate conformance guard: the
GrowthMilestoneAnalyst gains rule **R6 (dev-gate conformance)**. On a development
agent, every registered dev-gated feature (the Slice-2 `DEV_GATED_FEATURES`
registry) must resolve LIVE; one observed DARK is surfaced as a proactive
growth-analyst finding ("dev-gated feature X is dark on this dev agent — likely a
hardcoded enabled:false default or an operator override"). This catches the
forgot-the-gate-entirely / misconfig class that the Slice-1 lint can't see and
the Slice-2 default-test only catches at the default level — and it catches it on
the live config of the very dev agent it affects.

## Evidence

R6 is a preventive/observability layer, so "evidence" is a both-sides demonstration:
- **Catches the regression:** on a `developmentAgent: true` config with a
  registered feature's flag forced `false`, `computeFindings()` emits an R6
  finding for that feature and `buildDigest().counts.devGateDark > 0` (test:
  `growth-analyst-devgate-r6.test.ts`).
- **Stays quiet otherwise:** all-live-on-dev → no R6; fleet agent (even with a
  feature forced dark) → no R6 (fleet darkness is expected); `liveConfig` absent →
  skipped; `devGateConformance` rule disabled → skipped.
- **No regression to existing rules:** the 42 existing GrowthMilestoneAnalyst /
  routes / gate-wiring tests stay green (R6 is inert without `liveConfig`).

## What to Tell Your User

Nothing requiring action. On a development agent the growth digest may now include
a "dev-gated feature X is dark" finding if a feature is misconfigured — that is the
guard working. No fleet-facing change (dark for the fleet, live on dev agents).

## Summary of New Capabilities

- GrowthMilestoneAnalyst rule R6 (`devGateConformance`, default on) + `liveConfig`
  dep + `devGateDark` digest count.
- Completes the dev-gate guard (lint → default-test → runtime cross-check) —
  CMT-1253. <!-- tracked: CMT-1253 -->
