# Token-Burn Detection — Phase 6 ELI16

## What this ships

The final piece, plus the wiring that makes the whole system actually fire.

Five minutes after the runbook installs a slowdown, the new verifier checks: did the slowdown actually work?

If yes, you get a follow-up Telegram message in the same shape as the manual fix report from 2026-05-15 — "Caught and contained. Before the slowdown it was running at fifty million tokens an hour; it is now running at five million. That is a ninety percent drop. The slowdown will lift on its own at the configured time."

If no — meaning the rate did not drop after the slowdown went in — you get a different message. The agent says it tried but the slowdown did not take effect, and explains the two likely causes: either the attribution was pointing at the wrong code path, or the offending code path does not honor the rate gate.

The second piece in this release is the wiring. About thirty lines of construction-order code in the agent's server file. When the agent starts up, the six-phase pipeline now instantiates and begins running automatically: detector polls every sixty seconds, runbook subscribes to its signals, alert buttons stand ready, verifier waits to confirm fixes.

## The full cycle, end-to-end

After this release, the burn-detection-and-self-heal system is live on every instar agent:

1. The chokepoint captures every LLM call and writes attribution to the token ledger.
2. The detector wakes every sixty seconds, sees a burn, raises a flag.
3. The runbook decides — alert only, throttle, or both — based on whether the offender is a known component, whether auto-throttle is enabled, and whether the key is currently snoozed.
4. If it throttles, a Telegram message goes out with four signed buttons: Release, Snooze 24h, Extend +1h, Investigate.
5. Five minutes later, the verifier re-samples and sends the follow-up.
6. Sixty minutes after the throttle installs, it lifts on its own.

The 2026-05-15 incident — three billion tokens a day from one component, caught only because you noticed the bill — would now be: detected within thirty minutes, throttled in another five seconds, slowdown verified five minutes later, with a Telegram follow-up explaining the before-and-after. No human needed in the loop.

## How we know it works

Nine new tests for the verifier all pass. The full burn-detection test suite is one hundred and five tests across the six phases, all green. The full TypeScript build passes (`tsc --noEmit` is clean across the tree).

The AgentServer integration is small (about thirty lines) and follows the same pattern the existing TokenLedgerPoller uses for startup and shutdown.

## What changes for you operationally

After this lands and you upgrade, your agent on this machine will automatically have the full system running. You will not see anything new unless a burn happens. The default thresholds are tuned to catch the 2026-05-15 pattern (twenty-five percent of twenty-four-hour spend, or doubling of seven-day baseline with a ten million tokens per hour floor) and to avoid alerting on smaller bursts.

When a burn does happen, you will see a Telegram message explaining what was caught, four buttons for action, and five minutes later a follow-up with the before-and-after numbers — or an escalation if the slowdown did not work.

That is the system you approved. It is now real.
