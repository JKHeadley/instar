# Token-Burn Detection — Phase 5 ELI16

## What this ships

Phase five gives you a way to act on a burn alert without typing anything. When the agent catches a burn and sends you a Telegram alert, the message now comes with four buttons:

- **Release** — lift the slowdown right now.
- **Snooze 24h** — "this is fine, leave this component alone for a day."
- **Extend +1h** — keep the slowdown going for another hour.
- **Investigate** — log it, no state change; useful when you're going to look at it shortly.

Three things make the buttons safe, all from the audit:

1. **Only you can tap them.** Every button carries your Telegram user ID baked into the audit chain. If anyone else somehow gets the message (a shared topic, a leaked screenshot), their tap is rejected.
2. **Tampered buttons fail.** Each button is cryptographically signed. If someone tries to change "snooze" to "release" or alter the attribution key, the signature does not match and the agent refuses.
3. **Each button taps once.** A captured button cannot be pressed twice — the agent remembers the signal-ID and refuses replays.

The fourth piece of this phase is structural: a small adapter that connects the phase three detector and the phase four runbook into the live degradation chain. From this release on, when the detector raises a flag, the runbook will actually fire in production (where in phase four it was only invokable by tests). The runbook honors a snooze you set — if you snoozed a key, the next time it burns the agent will still alert you, but it will not throttle.

## The actual Telegram-wire integration is the next piece

This phase ships the pure logic of buttons and verification — every button shape, every signature check, every action handler — fully tested with fifteen unit tests. What lands in phase six (or as a small follow-up commit) is the actual integration into the Telegram adapter so the buttons appear on real messages and tapping them actually fires the handler. The pure module is the harder part; the wire-up is mechanical and small.

## What you'd notice

After phase six wiring lands, when a burn fires you'll see four buttons under the alert message. Tap one. If it's a legitimate action from you, it takes effect within a second and the agent replies with a status line ("Released. The throttle on InputDetector is lifted."). If somehow the tap comes from anyone else or the data is malformed, the agent ignores it.

A specific case to know: tapping "Snooze 24h" does NOT silence the burn alerts. It only stops the throttle from auto-installing. The next time the same component crosses the threshold, the agent will still send a Telegram alert that explicitly says "this key is currently snoozed; I will not slow it down." This is intentional — a snoozed key may have been a legitimate one-time burst the user said was OK, but if it keeps burning, the user should know.

## How we know it works

Fifteen tests in `tests/unit/burn-detection-phase-5.test.ts`. They cover: each of the four buttons doing what it says, the principal check accepting your user ID and rejecting any other, the signature check rejecting any tamper, the replay check rejecting the same button-press twice, the snooze TTL auto-expiring after twenty-four hours, the runbook honoring a snoozed key, and the subscriber adapter correctly registering the runbook as a healer for token-burn-detection events.

The phase four test suite (twenty-two tests) is untouched and passes — no regression on the previous phase's behavior.

## What's next

Phase six does two things:

1. **Verification step.** Five minutes after a throttle goes in, the runbook re-samples the token-ledger telemetry to confirm the rate actually dropped. If it dropped, you get a follow-up message with the before-and-after numbers. If it did not drop — meaning the throttle was pointed at the wrong key — the agent escalates explicitly: "I tried to throttle X but the rate did not drop; the actual offender is probably Y."

2. **The remaining wiring.** Hooking `registerBurnDetectionSubscriber` into the agent's startup and emitting the Phase 5 buttons via the existing Telegram adapter. That gets you the end-to-end live flow.
