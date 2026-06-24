---
title: Idle-monitor throttle settle-gate — bring the idle path's throttle detection up to the watchdog's settle discipline
slug: idle-throttle-settle-gate
eli16-overview: idle-throttle-settle-gate.eli16.md
status: draft
parent-principle: "Structure beats Willpower — replace a fragile single-glance heuristic (emit recovery the instant a throttle STRING appears) with the same structural settle check the SessionWatchdog already uses (throttle present AND pane byte-identical across polls = the turn genuinely ended on the throttle), so the idle path cannot be fooled by a stale/transient throttle line."
author: echo
created: 2026-06-24
review-convergence: "2026-06-24T23:08:11.183Z"
review-iterations: 2
review-completed-at: "2026-06-24T23:08:11.183Z"
review-report: "docs/specs/reports/idle-throttle-settle-gate-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 3
contested-then-cleared: 0
approved: true
approved-by: "echo (standing 8-hour autonomous-run pre-approval, 2026-06-24; design forks are mine to resolve)"
---

## Problem (the safe slice of the F3 residual, CMT-1785)

PR #1262 fixed the user-facing false-rate-limit spam at its source: a FINISHED session can no longer become a recovery target (the `isSessionRecoverable` guard). The remaining residual is a still-RUNNING idle session: the SessionManager idle-monitor emits `rateLimitedAtIdle` the instant `detectRateLimited(last-30-lines)` matches — a SINGLE glance. That false-fires when the throttle line is stale scrollback the session has since moved past, or a transient throttle that already cleared. With PR #1262's guard in place this self-corrects to ≤1 stray "back online" message (not the spam), but it is still an unnecessary recovery.

The SessionWatchdog ALREADY solves exactly this for its own path: `evaluateThrottleSettle` (monitoring/rateLimitDetection.ts) only hands to recovery when the throttle is present AND the pane is byte-identical across polls for ≥ settleMs — because a working Claude session animates its spinner/timer every tick, so an unchanged pane proves the turn ended on the throttle. The idle path does NOT use this discipline. This spec brings it up to parity.

## Scope (what this ships — additive, dark-flagged, strictly more conservative)

- **`nextIdleThrottleAction`** (new pure function next to `evaluateThrottleSettle`): given the settled-lines snapshot + per-session prior settle state + now, returns `'emit'` (settled → hand to recovery), `'wait'` (throttle present but not settled / pane changed → recheck next tick, do NOT emit), or `'fall-through'` (no throttle in the settled window → not a current throttle; continue to the generic-error check). Pure + clock-injected → unit-tested without tmux.
- **SessionManager idle path**: behind a dark flag, on EVERY idle tick (not just the first — this is load-bearing: the settle clock must be re-sampled across polls to ever reach 'settled') the idle-monitor captures the settled-lines window and consults `nextIdleThrottleAction`. 'emit' → hand to the sentinel; 'wait' → re-sample next tick (do not emit, do not run the generic nudge / idle-kill while a throttle is present-but-unsettled — mirroring the watchdog's 'waiting'); 'fall-through' → no current throttle, proceed to the normal idle machinery. When the flag is ON this OWNS the rate-limit hand-off; the first-idle-tick block fires the legacy immediate emit only when the flag is OFF. Per-session settle state (`Map<tmuxSession, ThrottleSettleState>`), cleared on completion (unconditionally, in the constructor — not gated on `setPromptDetector`), on emit/fall-through, and when the session goes active again.
- **Dark flag** `monitoring.idleThrottleSettleGate` (DEV_GATED_FEATURES, `enabled` omitted ⇒ dev-agent live / dark-fleet). Flag off ⇒ byte-identical legacy immediate emit.

## Why this is safe (the load-bearing claim)

It is STRICTLY more conservative than today: the gate can only ever make the idle path emit `rateLimitedAtIdle` LESS often, never more — so it cannot create a recovery that did not already happen. **It does not strand a genuinely-throttled idle session** because the settle check is re-sampled EVERY idle tick (not once): a real throttle has a stable pane (the turn ended on it), so it reaches 'settled' within `settleMs` and the idle path itself hands off — the recovery just arrives a few seconds later than the legacy single-glance, not never. (Adversarial round-1 caught the inverse: an earlier draft ran the check only on the first idle tick, making 'settled' unreachable and silently delegating to the watchdog — fixed by the per-tick re-sample.) The case the gate suppresses is exactly the target: a throttle string that is stale scrollback or a transient that cleared, where the pane is NOT stably the throttle. A pane that never settles means the session is animating output (working), not idle-stuck — the same property the SessionWatchdog's settle loop has, and the watchdog independently backstops the same class regardless. Reversible by flipping the flag.

## Decision points

- **Settle-gate the throttle emit only, not the generic `apiErrorAtIdle` path.** `evaluateThrottleSettle` is throttle-specific (it keys on the throttle string). The generic transient-API-error emit has no equivalent settle infra; gating it would need a parallel mechanism — out of scope. The throttle path is the one the incident implicated.
- **Re-capture the settled-lines window (RATE_LIMIT_SETTLED_CAPTURE_LINES) for the check** rather than reuse the 30-line `recentOutput`, matching the watchdog exactly, so the two paths agree on what "throttle present" means.
- **Pure decision extracted to `nextIdleThrottleAction`** so the new logic is unit-testable without tmux (the SessionManager idle loop is not unit-testable directly).
- **Reuse, not duplicate, the watchdog's settle machinery.** `nextIdleThrottleAction` is a thin wrapper over the SAME `evaluateThrottleSettle` the watchdog uses (it only re-maps the 3-way decision for the idle caller) — no parallel settle implementation. The deeper refactor (a single shared settle path / removing the now-redundant idle emit) is the CMT-1785 follow-up; <!-- tracked: CMT-1785 --> this spec adds the discipline conservatively without that surgery (cross-model review noted the redundancy — it is deliberate and tracked).
- **Per-tick capture cost (scalability, honest).** When the flag is ON, each idle session triggers one settled-lines tmux capture per monitor tick (only while idle) — the SAME per-tick capture the SessionWatchdog already does for every session. Bounded by idle-session count; dark/dev-only, so the fleet sees nothing until a deliberate soak. Acceptable for the dev-gated scope; a shared single capture is part of the CMT-1785 unification.

## Signal vs authority

The gate only ever WITHHOLDS a recovery signal (a spurious `rateLimitedAtIdle`); it adds no new kill, send, or authority. The RateLimitSentinel remains the recovery authority; this just stops feeding it a false trigger. `nextIdleThrottleAction` returns a decision the caller acts on — a signal, not an authority.

## Multi-machine posture

Machine-local-by-design: the idle-monitor + the per-session settle map are per-process state about sessions running ON this machine. No replicated/proxied state; single-machine and multi-machine behave identically.

## Out of scope (the deeper F3 redesign stays CMT-1785)

- Unifying the two detection paths (idle-monitor emit vs SessionWatchdog settle-check) so recovery isn't driven by two independent triggers — a design fork (gate-both vs remove-the-redundant-idle-emit, the latter needing a watchdog-coverage proof). This spec adds the settle discipline to the idle path WITHOUT removing it; the unification is the follow-up. <!-- tracked: CMT-1785 -->
- Distinguishing an active-tail throttle from old scrollback in `detectRateLimited`/`throttleSignature` (the long-idle-stale case both paths still trip). That is a shared-detection redesign affecting the watchdog too.

## Frontloaded Decisions

- **D1 — Dark-flagged, strictly-conservative.** Ships behind `monitoring.idleThrottleSettleGate` (dev-live / dark-fleet); flag off = byte-identical legacy. *Cheap-to-change-after:* the flag.
- **D2 — Throttle emit only (not apiError).** Scoped to the path with settle infra. *Cheap-to-change-after:* additive; the apiError path is untouched.
- **D3 — Add the settle discipline, do NOT remove the idle emit.** The two-path unification is deferred (CMT-1785); <!-- tracked: CMT-1785 --> this is the safe additive half. *Cheap-to-change-after:* removing the idle emit later is a separate flag-gated change.

## Open questions

*(none)*
