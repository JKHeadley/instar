# Phones belong to people: owner and MSP phones in the Instar app

<!-- bump: patch -->

## What Changed

- Each phone paired with the Instar iPhone app now belongs to one person from the agent's user list, with a role: `owner` or `msp`. An MSP is the company or person that runs the agent for its owner. Every phone paired before this release counts as the owner's.
- `POST /mobile/pairing-codes` takes `{"userId":"…","role":"msp"}` to make a link for a named person. The owner still gets the confirmation code, and the message names whose phone it is. `POST /mobile/devices/:id/person` (API token) can turn an owner phone into an MSP's, never the reverse.
- Messages from an MSP phone carry the MSP's name and never the owner's Telegram or Slack identity.
- By default an MSP phone can't open the owner's own app conversations or use Slack. The owner can switch either one on per MSP, only from the owner's own phone (`POST /mobile/people/:userId/grants`). `GET /mobile/people` shows the switches.
- A phone whose person was removed from the user list is refused (`403 person-unknown`). It never becomes an owner phone.
- The dashboard Phones card shows whose phone each one is. A new CLAUDE.md section, "Phones belong to people", tells the agent how to pair a phone for an MSP.

## What to Tell Your User

If someone else also helps run your agent, such as an IT company or an assistant, they can now have the Instar app on their own phone. Their messages show their own name, not yours. They can't see your private app chats or post in your Slack unless you switch that on for them from your phone. Ask me to "add a phone for <name>" and I'll set it up.

## Summary of New Capabilities

- Phones paired for named people, with owner and MSP roles.
- An owner-only switch per MSP for the owner's app chats and for Slack.
- Every app message, mirror and history row carries the real sender's name.

## Evidence

Spec `docs/specs/mobile-app-people-and-roles.md`, converged in 4 cross-model rounds. Tests:
- `tests/unit/mobile-app-people-roles.test.ts` (27)
- `tests/integration/mobile-app-people-roles.test.ts` (12)
- `tests/e2e/mobile-app-people-roles-alive.test.ts` (on a real server boot)

All existing mobile unit, integration and e2e tests pass.
