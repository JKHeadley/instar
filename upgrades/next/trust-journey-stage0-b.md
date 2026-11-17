<!-- bump: patch -->
## What Changed

The person can now approve a change that widens what the agent may do, from their own direct chat with the agent (trust journey stage 0, part B; docs/specs/trust-journey.md). The agent opens the exact request; the server sends a card into the owner's Telegram private chat with the bot (or Slack DM) that says, in plain words, everything the change would widen, and the person replies `approve <code>` to that card. The first time, the person is asked once to send back a one-sentence acceptance that replies from their account count as their approval. Only a reply that really arrived from the platform counts: not the agent's token, not the dashboard PIN, not a phone tap, not a message replayed after an outage. Every approval says plainly that it came from an account the agent can also use. Trust changes are now kept in a durable log (replicated where the machines share one), and at startup each stored setting is checked against it: anything wider than what was approved is put back, and the owner is told once. A console switch whose setting needs approval now opens the request instead of failing.

## What to Tell Your User

- "When you want me to stop asking about something or to work more on my own, I'll send a short card to our private chat. Reply to it with the code it shows, and only then does the setting change. Any other reply changes nothing."
- "The first time, I'll ask you to send one sentence back once, confirming that your replies count as your approval."

## Summary of New Capabilities

- Approving a widening from the person's own direct chat: a server-written card, answered with `approve <code>`.
- A durable trust change log, with a startup check that puts back any setting wider than what was approved.

## Evidence

- `tests/unit/trust-journey-*.test.ts`, `tests/integration/trust-account-path-routes.test.ts`, `tests/e2e/trust-account-path-alive.test.ts`.
- Live proof on a throwaway agent with a real Telegram bot: see the PR.
