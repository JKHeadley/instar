---
slug: restart-cascade-dampener-and-lifeline-drift-promote
title: Restart cascade dampener + lifeline drift auto-promote
date: 2026-05-22
author: echo
review-convergence: internal-single-pass-2026-05-22
approved: true
approved-by: Justin
approved-via: Telegram topic 11838 ("please proceed" at 2026-05-23 00:27 UTC)
eli16-overview: restart-cascade-dampener-and-lifeline-drift-promote.eli16.md
---

# Spec — Restart Cascade Dampener + Lifeline Drift Auto-Promote

## Problem

Two coordinated self-heal gaps were surfaced by Luna's 2026-05-22 incident
(Telegram topic 11838):

1. **Update-driven restart cascades.** When two updates arrive within minutes
   of each other (Luna: v1.2.34 at 22:13 UTC, v1.2.36 at 23:11 UTC),
   `AutoUpdater.gatedRestart` fires a separate user-visible restart cycle for
   each. From the user side, this looks like two back-to-back outages. The
   existing 30-minute SAME-VERSION cooldown does not cover DIFFERENT versions.

2. **Silent lifeline patch drift.** When the server's version handshake on
   `/internal/telegram-forward` observes the lifeline is significantly behind
   (PATCH diff > 10), it emits a degradation report whose `impact` field has
   historically been "Lifeline hasn't restarted in a while; consider manual
   kick." Nothing acts on it. Luna's lifeline at the incident was 30 patches
   behind the server with no auto-correction.

## Goal

Close both gaps with structural enforcement — no agent action required, no
user CLI to run, no "remember to do X" prose. Defaults applied to existing
agents via `PostUpdateMigrator`. Tunable in `.instar/config.json` for users
who want different windows or thresholds.

## Decisions

### Restart Cascade Dampener

- New pure-logic class `src/core/RestartCascadeDampener.ts` with a `decide()`
  method that returns `proceed | batch`. Stateless — consults
  AutoUpdater's existing persisted `lastRestartRequestedAt` plus a
  configured window.
- AutoUpdater consults it inside `gatedRestart`, AFTER the existing
  same-version 30-min cooldown and BEFORE the restart-window gate.
- On `batch`: a single delayed `setTimeout` fires at `lastRestart +
  windowMs`. Subsequent `gatedRestart` calls during the batch window update
  the queued target version (max-semver wins) without spawning another
  timer. Lower-version requests during a batch are ignored (never
  downgrade).
- User-visible: one `Update vX queued — rolling into the pending restart
  at HH:MM` notice, sent ONCE per batched version (reuses existing
  `lastNotifiedRestartVersion` for dedup).
- Default window: 15 min. Configurable via
  `updates.restartCascadeDampenerWindowMs` in `.instar/config.json`.
  `0` disables the dampener entirely.
- `bypassWindow=true` (manual `/updates/apply`) skips the dampener — the
  user explicitly asked.
- Crash / health-fail / version-skew restarts are NOT dampened — they
  flow through `RestartOrchestrator` directly with different semantics.

### Lifeline Drift Auto-Promote

- Server route `/internal/telegram-forward` sets `X-Instar-Lifeline-Patch-Drift:
  <N>` on the response when `compareVersions(...) === accept-with-patch-info`
  (PATCH diff > 10). The existing `DegradationReporter` emission is also
  retained but updated to credit the promoter instead of "consider manual
  kick."
- New sentinel class `src/lifeline/LifelineDriftPromoter.ts` owns the
  detect → defer → verify → request → finalize lifecycle:
    - `noteDrift(N)` is called by `TelegramLifeline.observeForwardResponseDriftHeader`
      whenever a successful forward carries the header.
    - When `N >= threshold` (default 20) and state is `idle`, transitions to
      `pending` and starts a 30s tick.
    - Each tick checks `isCleanWindow()` (no in-flight forwards, no queued
      messages, last forward success > 90s ago). When clean, fires
      `requestSelfRestart('drift-auto-promote')` which delegates to the
      existing `RestartOrchestrator`. State becomes `fired` (terminal).
    - Hard deadline: even if never clean, fires after `maxDeferMs` (default
      60 min) with `drift-auto-promote-deadline` reason.
    - Disabled via `lifeline.driftPromoter.enabled: false` — promoter starts
      in `disabled` state and `noteDrift` becomes a noop.
- A marker file `state/lifeline-drift-restart-pending.json` is written
  BEFORE the orchestrator request so the post-restart boot can send a
  one-shot user notice ("Lifeline self-restarted: was N patches behind,
  now in sync at vX.Y.Z."). Boot-time consumer is atomic + idempotent.

## Configuration

```json
{
  "updates": {
    "restartCascadeDampenerWindowMs": 900000
  },
  "lifeline": {
    "driftPromoter": {
      "enabled": true,
      "threshold": 20,
      "pollIntervalMs": 30000,
      "maxDeferMs": 3600000
    }
  }
}
```

Defaults flow through `src/config/ConfigDefaults.ts` → `SHARED_DEFAULTS`,
applied to existing agents via `PostUpdateMigrator.migrateConfig` (which
calls `applyDefaults`). User customizations are preserved by the
"only add missing keys" rule.

## Signal vs Authority

Per `feedback_signal_vs_authority`:

- Server handshake = signal. It reports the observed drift via a response
  header. It does not decide whether to restart.
- `LifelineDriftPromoter` = gate with full context. Knows the lifeline's
  queue state, the clean-window predicate, the hard deadline. Decides to
  act.
- `RestartOrchestrator` = authority for the actual exit. Handles quiesce,
  persist, shadow-install coordination, process.exit. Reused unchanged.

For the cascade dampener:

- `RestartCascadeDampener.decide()` = pure logic. No I/O, no side effects.
- `AutoUpdater` = existing authority for update-driven restarts. Consults
  the dampener, interprets the decision, owns the timer and notification.

## Own the Lifecycle

Per `feedback_own_the_lifecycle_pattern`, the `LifelineDriftPromoter` is a
single sentinel class that owns the full detect → defer → verify → request
→ finalize lifecycle. Multiple `noteDrift` calls feed the same instance.
Tests cover: throw-tolerance in the clean-window predicate, hard-deadline
fire, terminal-state idempotency (no double-fire under concurrent ticks),
state machine transitions (idle → pending → fired, plus disabled).

## Migration

- `ConfigDefaults.ts` — adds `updates.restartCascadeDampenerWindowMs` and
  `lifeline.driftPromoter` to `SHARED_DEFAULTS`. Auto-applied to existing
  agents on update via `PostUpdateMigrator.migrateConfig` →
  `applyDefaults` (only adds missing keys).
- `PostUpdateMigrator.migrateClaudeMd` — adds "Self-Heal: Update Restart
  Behavior" section to existing agent `CLAUDE.md` files. Content-sniffed
  for idempotency.
- `generateClaudeMd` in `templates.ts` — same section for new agents.
- No hook script changes, no skill changes, no built-in job changes.

## Testing

- `tests/unit/RestartCascadeDampener.test.ts` — 9 pure-logic tests
  (window math, boundaries, corrupt timestamps, validation).
- `tests/unit/AutoUpdater-cascade-dampener.test.ts` — 7 integration tests
  exercising the AutoUpdater wiring under fake timers. The first test
  reproduces Luna's exact symptom and asserts only ONE restart flag is
  written.
- `tests/unit/lifeline/LifelineDriftPromoter.test.ts` — 15 unit tests
  (config validation, disabled, threshold gating, immediate-fire, defer-
  then-fire, max observed diff, throw-tolerance, hard deadline,
  idempotency, double-fire prevention, stop()).
- `tests/integration/telegram-forward-patch-drift-header.test.ts` — 4
  integration tests against the real `createRoutes()` route, asserting
  the header is set/unset at the correct boundaries.
- `tests/e2e/self-heal-cascade-and-drift.test.ts` — 5 lifecycle tests
  including the load-bearing end-to-end "real route emits the header"
  assertion + migration parity verification.

## Rollback

- Cascade dampener: set `updates.restartCascadeDampenerWindowMs: 0` and
  restart the server. Behavior reverts to pre-feature.
- Drift promoter: set `lifeline.driftPromoter.enabled: false` and restart
  the lifeline. Server still emits the patch-info degradation; nothing
  acts on it.
- Code revert: a `git revert` of the commit is clean. Config keys remain
  harmless if the code no longer reads them.

## Scope boundary

This PR delivers items #1 and #3 from the topic-11838 proposal Justin
reviewed and approved. Two independent items from that same proposal are
NOT part of this change and are tracked separately:

- The Remediator dispatcher (proposal item #4) — generalize the existing
  `src/remediation/Remediator.ts` scaffolding to act on health-probe
  remediation strings. <!-- tracked: gh-338 -->
- A "conversation-aware quiet window" guard (proposal item #5) that holds a
  non-critical restart while there's an unanswered user message younger
  than 5 minutes on any topic. <!-- tracked: gh-339 -->

Both are real, captured as GitHub issues #338 and #339, and were visible to
Justin in the original proposal — not orphaned scope-drops.
