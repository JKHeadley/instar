# Make a work card from a message in Conversations

<!-- bump: patch -->

## What Changed

In the console's Conversations page, each message in a Telegram or app conversation has a "Make a card" button. It opens a short form filled in from the message (title, what is needed), asks when it is done, and, after the dashboard PIN, puts the card on the work board with a record of the message it came from. Nothing is approved by making a card.

## What to Tell Your User

You can turn any message in a conversation into a work card: open the conversation in the dashboard, press "Make a card" under the message, check the title, say when it is done, and enter your PIN. The card opens on the work board.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Make a card from a message | Conversations → a conversation → "Make a card" under a message |

## Evidence

- `tests/unit/console-make-card.test.ts`.
