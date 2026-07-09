# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A signal-only **red-PR watchdog** on the existing green-PR auto-merge watcher. Green-PR
auto-merge only ever acts on GREEN PRs, so a PR of mine that goes RED and *stays* red is
invisible to it — which is exactly how PR #1399 sat red overnight on 2026-07-08 until the
operator found it on his morning check-in (an operator-found escape). The watchdog closes
that gap: after the merge logic runs each tick, it checks my own open PRs and raises ONE
deduped, age-escalating attention line — `PR #N red for Xh — <failing check names>` — for
any PR with a required check stuck RED past a threshold (default 2h). It is SIGNAL-ONLY:
it never merges, closes, or blocks anything.

- `src/monitoring/greenPrLogic.ts` — new pure helpers `latestRunPerCheck` (dedup a rollup
  to the newest run per check name), `failingChecksFromRollup`, and `stuckRedChecks`; plus
  a `failingChecks` field on `PrSummary`. **Correctness fix:** `deriveRollup` now dedups to
  the latest run per check BEFORE collapsing — a stale FAILED run superseded by a passing
  re-run previously still read `FAILURE` (the exact bug the overnight incident surfaced),
  which also made the green-PR merger refuse an actually-green PR.
- `src/monitoring/greenPrAutomergeWiring.ts` — `mapPr` populates `failingChecks` from the
  same `statusCheckRollup` the list projection already fetches (no new gh call).
- `src/monitoring/GreenPrAutoMerger.ts` — `tick()` runs `redPrWatchdogPass` after the merge
  logic; a per-PR `redPrRaised` memory (in state) dedups to ONE item, re-raised only on age
  escalation or a changed failing-check set, and cleared when the PR goes green / merges /
  closes. New `redPrWatchdog` config (`{ enabled, redThresholdMs }`, default
  `{ enabled: true, redThresholdMs: 7_200_000 }`).
- `src/server/routes.ts` — `GET /green-pr-automerge` now returns `stuckRed[]` +
  `redPrWatchdog` config so "why did I get a red-PR alert?" is answerable from state.
- `src/config/ConfigDefaults.ts`, `src/core/types.ts`, `src/commands/server.ts` — the
  config default, type, and constructor wiring.

The watchdog runs only where the parent green-PR watcher already runs (a maintainer/dev
agent with an analyzable instar repo + safe-merge); on every other install it is inert,
exactly like the parent feature.

## What to Tell Your User

- **A pull request of mine that gets stuck RED now surfaces itself.** "If one of my own PRs
  has a required check that keeps failing for more than a couple of hours, I'll raise a
  single quiet heads-up in your attention queue — naming the PR, how long it has been red,
  and which checks are failing — instead of it silently sitting there unmerged. You get one
  item per stuck PR, not a stream; it updates as the PR ages, and it clears itself the moment
  the PR goes green, merges, or closes." This only applies on the maintainer agent that runs
  green-PR auto-merge; it never merges or closes anything on its own — it just tells you.
- **A subtle merge bug got fixed too.** A PR whose failed check was later re-run green used
  to still read as failed — which could stop it from auto-merging. Now the newest run of
  each check wins, so a re-run-green PR is correctly seen as green.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A self-authored PR stuck RED past 2h raises ONE deduped attention line | Automatic wherever `monitoring.greenPrAutoMerge` is enabled |
| See which of my PRs are flagged red and for how long | `GET /green-pr-automerge` → `stuckRed[]` + `redPrWatchdog` |
| Tune the "stuck" threshold or turn the watchdog off | `monitoring.greenPrAutoMerge.redPrWatchdog` = `{ enabled, redThresholdMs }` |
| Re-run-green PRs are no longer misread as failed | Automatic (`deriveRollup` latest-run dedup) |

## Evidence

- Unit (`tests/unit/green-pr-red-watchdog.test.ts`, 24): the pure helpers on both sides —
  `latestRunPerCheck` keeps the newest run per check; `failingChecksFromRollup` /
  `stuckRedChecks` flag past-threshold failures and skip fresh / unknown-time ones; the
  `deriveRollup` latest-run-dedup regression (stale FAILED + later passing re-run → SUCCESS,
  not FAILURE); and the orchestrator pass cases (a) raises one line past threshold, (b) none
  below threshold, (c) re-run-green not stuck, (d) same PR two ticks → ONE item, (e) green →
  none, (f) not-authored-by-me skipped, plus recovery/close clears, age-escalation re-raise,
  disabled no-op, and the `redPrWatchdogView` read surface.
- Unit (existing `green-pr-logic` / `green-pr-automerger` / `green-pr-automerge-wiring` /
  `green-pr-layer2`, 92): unchanged behavior for single-run rollups — no regression.
- Integration (`tests/integration/green-pr-automerge-routes.test.ts`, +2): `GET
  /green-pr-automerge` surfaces `redPrWatchdog` config + an empty `stuckRed[]` when nothing
  is red (feature-alive), and populates `stuckRed[]` after a tick over a stuck-red PR.
- `npx tsc --noEmit` clean; the dark-gate ConfigDefaults line-map snapshot updated for the
  +4 line shift (no new/removed dark features).
