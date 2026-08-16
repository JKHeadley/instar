# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Phase six of the token-burn-detection-and-self-heal system — the final piece. Plus the wiring that makes the whole six-phase pipeline fire on live burns.

What lands today:

- A verifier that re-samples the token ledger five minutes after a slowdown is installed. If the rate dropped, it sends a Telegram follow-up with the before-and-after numbers. If the rate did not drop, it sends an escalation message explaining the two likely causes.
- The wiring in the agent's startup that instantiates the six-phase pipeline. From this release on, when the agent starts, the detector begins polling the token ledger every sixty seconds, the runbook subscribes to its signals, and the verifier waits to confirm any throttles take effect.

This completes the cycle: detection, alert, slowdown, verification, follow-up. Six phases plus the wiring, all live.

## What to Tell Your User

Your agent now has the complete self-watch system you approved. From this release on, when one component starts burning tokens, the agent will catch it within thirty minutes, slow it down, verify the slowdown worked, and send you a Telegram message with the before-and-after numbers — all without you having to look at the bill.

The system is on by default at conservative thresholds (a quarter of the daily budget, or a doubling of the seven-day baseline). You can adjust thresholds or turn the whole thing off in your agent's config file.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Post-throttle re-sample at five minutes | Automatic. |
| Caught-and-contained follow-up Telegram | Automatic. |
| Did-not-take-effect escalation Telegram | Automatic. |
| Burn-detection auto-heal system live in production | Automatic on server startup. |

## Evidence

Nine new tests in `tests/unit/burn-detection-phase-6.test.ts` all pass. The full burn-detection test suite across the six phases is one hundred and five tests, all green. The full TypeScript build passes clean (`tsc --noEmit` returns zero).

Side-effects review for this phase is in `upgrades/side-effects/token-burn-detection-phase-6.md`. Second-pass review concurred with no blocking concerns.

The AgentServer wiring is about thirty lines of construction-order code in the server startup path, with matching shutdown handling so the detector stops before the ledger closes. The wiring is guarded by a try/catch so a misbehaving burn-detection actor cannot prevent the rest of the server from starting.

## What is outstanding

The Phase 5 Telegram inline-button receipt path — when you tap Release, Snooze 24h, Extend, or Investigate — still needs the small wiring change in `TelegramAdapter.ts` that hands incoming callback queries to `BurnAlertButtons.handle()`. The outgoing button render (`buildKeyboard`) is wired through; the inbound receive is the symmetric piece. That is a small follow-up commit, separable from this phase.
