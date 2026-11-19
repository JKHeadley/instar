# Telegram: an empty list no longer means anyone can use your agent

<!-- bump: patch -->

## What Changed

Who may use a Telegram agent was decided by its list of allowed people, and an empty list (the default) meant everyone. Agents that receive Telegram through their relay also skipped the list for commands and for the emergency stop.

Now one rule decides on every path: the server's own polling, the relay's forward, and the relay's own commands and downloads.
- **Who may use the agent:** you, people on the list, and people you have approved or registered.
- **Whole-agent controls:** only you can switch accounts, change routing, or restart and reset the relay.
- **Strangers:**
  - Someone the agent can identify as not allowed gets one private reply.
  - You get a join request in the agent's admin topic with a code, and answer `/approve <code>` or `/decline <code>`.
  - A refused message is never written into the conversation's history.

This turns on for development agents first. Everyone else's agents only watch: you get one item listing who would have been refused, and nothing is refused yet.

## What to Tell Your User

- **Who can use your agent**: "If someone you don't know writes to your agent on Telegram, I'll show you who it was. Once sender checks are on for your agent, they can't use it until you approve them; I'll give you a code to approve with."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Approve or decline a join request | Owner sends `/approve <code>` or `/decline <code>` in Telegram |
| Sender checks switch | `security.telegramSenderAuthority.enabled` (dev-gated: on for development agents) |

## Evidence

- Unit: `tests/unit/telegram-sender-authority.test.ts`, `tests/unit/identity-piece1e-sender-wiring.test.ts`.
- Throwaway: see the PR.
