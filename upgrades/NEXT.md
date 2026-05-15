# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Phase four of the token-burn-detection-and-self-heal system. This is the phase where the watcher gets hands. From this release on, when one of your agent's components is using more than its fair share of the token budget, the agent will automatically slow that component down for sixty minutes (auto-reverting), and send you a Telegram message explaining what was caught.

What lands today:

- The rate gate from phase one becomes stateful. It can now hold throttles, the throttles auto-expire, and they can be revoked.
- The new burn-throttle runbook receives the phase-three detector's signals and decides what to do — alert only, throttle and alert, or escalate.
- A cryptographic forgery guard on the gate (HMAC capability tokens) plus an anti-replay nonce so a leaked token cannot be reused.
- One URGENT escalation case: if the runbook itself ever shows up as a burn source, you get an URGENT Telegram message asking you to investigate — because that's the one case where staying quiet would be wrong.

The runbook is currently invoked through unit tests; wiring into the live degradation-event chain is the small follow-up in phase five.

## What to Tell Your User

The fourth of six pieces of the new self-watch system. Your agent can now automatically slow a misbehaving component down — bounded to sixty minutes, then it lifts on its own. If it happens, you'll get a Telegram message that says which component, why, and what the rate looked like.

The slowdown only ever applies to a single specific component. Everything else continues to run normally. If the slowdown turns out to be wrong, phase five (the next release) adds a one-tap button to release it; until then a release requires the operator to revoke through the agent.

If you ever see an URGENT message saying the burn-throttle runbook itself is being flagged, that's the one alert you should look at right away. It means either a bug in the runbook or attribution being mis-applied, and you should investigate.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stateful rate gate | Internal — managed by the runbook. |
| Burn-throttle runbook (Tier-2 decision authority) | Subscribes to burn-detection signals automatically once wired in phase five. |
| HMAC forgery guard on throttle installs | Automatic when an HMAC key is configured in the agent. |
| Anti-replay nonce on throttle installs | Automatic — every throttle has a unique signal-ID. |
| URGENT escalation when the runbook itself burns | Automatic Telegram alert. |

## Evidence

Twenty-two new tests in `tests/unit/burn-detection-phase-4.test.ts` all pass. Tests cover: every runbook outcome (throttle-installed, alert-only-unknown, alert-only-config-disabled, alert-only-self-attribution, throttle-failed), the gate's stateful behavior (install, decide, revoke, auto-expire), capability-token verification, anti-replay refusal, and the URGENT escalation message text.

The previous phase-one test suite (twenty-one tests) was updated for one assertion — the gate's no-throttle-installed reason replaces the old phase-one no-op reason. All twenty-one tests still pass.

Phase two (twenty-two tests) and phase three (sixteen tests) suites are untouched and pass — no regression.

Second-pass review was conducted on this phase (required because it touches blocking authority over LLM calls). The reviewer concurred with three specific concerns:

1. Capability tokens were infinitely replayable — fixed with a signal-ID nonce and a consumed-IDs map.
2. The in-process token mint is on the same object as the verifier — documented in the source as defending only the cross-process boundary.
3. Self-attribution was silently swallowed — replaced with an URGENT Telegram escalation.

All three fixes have tests. Side-effects review is in `upgrades/side-effects/token-burn-detection-phase-4.md`.
