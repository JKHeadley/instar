# Side-Effects Review — Idle-monitor throttle settle-gate

**Version / slug:** `idle-throttle-settle-gate`
**Date:** `2026-06-24`
**Author:** Echo (autonomous, 8-hour run)
**Spec:** `docs/specs/idle-throttle-settle-gate.md` (review-convergence + approved)
**Second-pass reviewer:** REQUIRED (touches the SessionManager idle/recovery path) — verdict appended below.

## Summary of the change

The safe slice of the false-rate-limit F3 residual (CMT-1785). The SessionManager idle-monitor emitted `rateLimitedAtIdle` (handing to RateLimitSentinel recovery) the instant `detectRateLimited(last-30-lines)` matched — a single glance, which false-fires on a stale/transient throttle line. Behind a DARK flag, the idle-monitor now gates that hand-off behind the SAME settle discipline the SessionWatchdog already uses (`evaluateThrottleSettle`: throttle present AND pane byte-identical across polls = the turn genuinely ended on the throttle). Strictly more conservative — it can only ever emit `rateLimitedAtIdle` LESS often, never more.

Files modified:
- `src/monitoring/rateLimitDetection.ts` — new pure `nextIdleThrottleAction` (a thin wrapper over the existing `evaluateThrottleSettle`; returns `'emit'`/`'wait'`/`'fall-through'`). No change to `evaluateThrottleSettle` or `detectRateLimited`.
- `src/core/SessionManager.ts` — (a) new dark-flagged per-tick settle check inside `if (isActuallyIdle)` AHEAD of the first-idle-tick gate, so the pane is re-sampled every tick (load-bearing — see F1 below); (b) the first-tick legacy emit fenced to `detectRateLimited(recentOutput) && !this.idleThrottleSettleGate` (flag-off only); (c) per-session `idleThrottleSettle` Map + `idleThrottleSettleGate` field from new opt; (d) unconditional cleanup of the Map on `sessionComplete` (constructor) + on session-active.
- `src/core/devGatedFeatures.ts` — new `idleThrottleSettleGate` DEV_GATED_FEATURES entry (`monitoring.idleThrottleSettleGate.enabled`, omitted ⇒ dev-live/dark-fleet).
- `src/core/types.ts` — `MonitoringConfig.idleThrottleSettleGate?: { enabled?: boolean }`.
- `src/commands/server.ts` — resolves the flag via `resolveDevAgentGate(...)` and threads it into the SessionManager opts.

Files added:
- `tests/unit/idle-throttle-settle-gate.test.ts` — 6 unit tests for `nextIdleThrottleAction` (every decision boundary: no-throttle→fall-through, first-sighting→wait, unchanged≥settleMs→emit, unchanged<settleMs→wait, pane-changed→wait+restart, transient-clears→fall-through).
- `docs/specs/idle-throttle-settle-gate.md` (+ `.eli16.md`, convergence report).

## Blast radius

- **Flag OFF (the FLEET, by default):** byte-identical to legacy. The per-tick block is skipped entirely (`if (this.idleThrottleSettleGate)` false); the first-tick emit fires exactly as before; the `idleThrottleSettle` Map is never written (cleanup deletes are no-ops on an empty map). Confirmed by the adversarial reviewer + the existing watcher/quota suites unchanged.
- **Flag ON (dev only):** the idle-path rate-limit hand-off is settle-gated. It only WITHHOLDS a spurious `rateLimitedAtIdle`; it never adds a kill/send/authority. RateLimitSentinel stays the recovery authority. The SessionWatchdog independently settle-gates the same class (the two emits are deduped by `RateLimitSentinel.report()`), so no double-recovery and no coverage gap.
- **Multi-machine:** machine-local-by-design — per-process state about locally-running sessions; no replicated/proxied state.
- **Migration parity:** dev-gated flag, `enabled` omitted from ConfigDefaults (no user default written) ⇒ no migration surface. No hooks/CLAUDE.md/skill/dashboard changes.

## Rollback

Flip `monitoring.idleThrottleSettleGate.enabled` false (or revert the commit) ⇒ legacy immediate emit. Fully additive and reversible; nothing irreversible ships.

## Second-pass reviewer verdict

Multi-angle spec-converge (adversarial + decision-completeness + lessons/integration internal lenses, + codex-cli:gpt-5.5 + gemini-2.5-pro external) over 2 rounds. Round 1 caught a CRITICAL functional defect (F1: the settle check ran only on the first idle tick → `'settled'` unreachable → flag-ON would emit recovery never, silently delegating to the watchdog) and a LOW map-cleanup leak (F2). Both fixed (per-tick re-sample; unconditional constructor cleanup) and verified RESOLVED + CONVERGED in round 2, with new adversarial checks (idle-kill starvation, flag-off regression, decision boundaries) clean. External minors (overstated safety claim; polling redundancy) folded into the spec. 130 unit tests green, no regression, clean typecheck. The one non-blocking note (per-tick wider capture cost when flag ON) is documented + deferred to the CMT-1785 unification. Verdict: APPROVED.
