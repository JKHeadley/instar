---
user_announcement:
  - audience: agent-only
    maturity: experimental
    summary: "(Dev-only, dark on the fleet) The idle session-monitor's rate-limit recovery trigger now uses the same 'has the screen actually stopped changing?' settle check the watchdog uses, instead of firing on a single glance at a throttle line."
---

## What Changed

The SessionManager idle-monitor used to hand a session to rate-limit recovery the instant it saw a throttle line in the last ~30 terminal lines — a single glance. That false-fires when the throttle line is stale scrollback the session has moved past, or a transient throttle that already cleared (the milder cousin of the false-rate-limit spam fixed in #1262). Behind a DARK flag (`monitoring.idleThrottleSettleGate`, dev-agent live / dark on the fleet), the idle-monitor now gates that hand-off behind the SAME settle discipline the SessionWatchdog already uses: a throttle must be present AND the terminal pane byte-identical across polls (a working session animates its spinner every tick, so a frozen pane proves the turn genuinely ended on the throttle). It is strictly more conservative — it can only ever trigger recovery LESS often, never more, so it cannot strand a genuinely-stuck session.

## Evidence

- **Reproduction (the gap):** the idle-monitor's `rateLimitedAtIdle` emit fired on `detectRateLimited(recentOutput)` from a single capture, with no settle check — unlike the SessionWatchdog's `checkRateLimited`, which already required a settled (pane-unchanged-across-polls) throttle before acting.
- **Before → after:** before, a still-running idle session with a stale/transient throttle line in its buffer got an unnecessary recovery hand-off (≤1 stray "back online" message, after #1262 neutralized the finished-session spam). After, the idle-monitor re-samples the pane every idle tick and only hands off once the throttle has genuinely settled; a stale or already-cleared throttle line no longer triggers recovery. Flag off (the fleet) is byte-identical to the legacy behavior.
- **Verified:** 6 unit tests for the pure settle decision (`nextIdleThrottleAction`, every boundary), 130 green across the rate-limit/watchdog suites, no regression, clean typecheck. Multi-angle review (3 internal lenses + codex + gemini, 2 rounds) caught a critical defect in an earlier draft (the settle check running only on the first idle tick, making "settled" unreachable) — fixed to re-sample every tick and verified.

## What to Tell Your User

Nothing visible day-to-day — this is internal session-watching behavior and it's off everywhere except the development machine until it's soaked. The eventual benefit is fewer unnecessary "back online" pokes from a session that wasn't really stuck.

## Summary of New Capabilities

- `monitoring.idleThrottleSettleGate` (dev-gated dark flag): settle-gate the idle-monitor's rate-limit recovery hand-off, bringing it to parity with the SessionWatchdog's settle discipline.
- `nextIdleThrottleAction` (pure helper): the unit-testable settle decision (`emit`/`wait`/`fall-through`) the idle path consults each tick.
- Deferred (CMT-1785): unifying the idle-monitor and watchdog detection paths (one shared trigger + one shared per-tick capture) + distinguishing an active-tail throttle from old scrollback.
