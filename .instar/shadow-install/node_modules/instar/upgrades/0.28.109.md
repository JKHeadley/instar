# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Phase five of the token-burn-detection-and-self-heal system. The two pieces that land here:

- Four buttons that go on every burn alert: Release, Snooze 24h, Extend 1h, Investigate. They are cryptographically signed and bound to your Telegram user ID, so only you can tap them and only on the original alert.
- A small adapter that connects the phase three detector and the phase four runbook into the live degradation chain.

The actual emit of the four-button inline keyboard on a real Telegram message, and the receipt of the tap from the Telegram webhook, is a small follow-up change to the Telegram adapter that lands in phase six. This release ships the pure pieces fully tested, so phase six can wire them with confidence.

## What to Tell Your User

The fifth of six pieces. From this release on, the system catches burns AND has the user-facing controls ready to land — the four buttons that will appear under each burn alert once phase six wires them.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Principal-bound burn alert buttons (pure module) | Automatic once phase six wires it into the Telegram adapter. |
| Snooze 24h state honored by the runbook | Automatic after wiring. |
| Subscriber wiring (runbook as degradation healer) | Automatic once phase six adds the startup hook. |

## Evidence

Fifteen new tests in `tests/unit/burn-detection-phase-5.test.ts` all pass. Tests cover: each of the four buttons doing what it says, the principal-bind accepting the authorized user and rejecting strangers, the signature check rejecting tampered callback data, the freshness check rejecting replay, the snooze TTL auto-expiring, the runbook honoring a snoozed key (alert-only-snoozed outcome), and the subscriber adapter registering correctly.

The phase four test suite (twenty-two tests) is untouched and passes — no regression.

Side-effects review for this phase is in `upgrades/side-effects/token-burn-detection-phase-5.md`. The reviewer concurred with no new concerns above the documented out-of-scope items.
