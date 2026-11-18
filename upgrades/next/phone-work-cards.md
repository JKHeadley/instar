# Work cards from the owner's phone

<!-- bump: patch -->

## What Changed

The Instar app can now open a single work card by itself, and turn a message into a work card with Face ID, the same "Make a card" the dashboard offers with its PIN. The card remembers the conversation and message it came from. Only the owner's own paired phone can do either; the agent cannot make a card in the owner's name this way. A retry of the same request gives back the same card instead of a second one. The app's own button and card screen come in an app release; until then, "Make a card" on the dashboard works on a phone.

## What to Tell Your User

- **Make a card from your phone**: "Soon you'll be able to turn any message into a work card from the Instar app with Face ID. The button arrives in an app update; until then, the dashboard's Make a card works on your phone too."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Open one work card from the phone | The Instar app (screen coming in an app release) |
| Make a card from a message with Face ID | The Instar app (button coming in an app release) |

## Evidence

- Unit: `tests/unit/phone-work-cards.test.ts` (draft shape and hash vectors, idempotent create, checks before Face ID).
- Integration: `tests/integration/phone-work-cards.test.ts` (real device and presence signatures through the production middleware).
- E2E: `tests/e2e/phone-work-cards-alive.test.ts` (the real server: the owner phone opens a card and makes one from a message).
