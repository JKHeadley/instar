# Team members now talk to your agent in a conversation of their own

<!-- bump: patch -->

## What Changed

Until now, when someone on your team wrote to your agent in Telegram, their message went into the same conversation you use. That conversation can run commands, open files and use your accounts.

Now a team member gets a conversation of their own:
- **The agent still answers them,** but it has no tools there: it can talk and explain, but it can't run anything, open files, use your accounts, or see your conversations.
- **What they say stays private to them.** It is kept in their own record, not your conversations, the agent's memory or its scheduled jobs.
- **You still see their messages in Telegram.** To have the agent act on one, quote or forward it into your own conversation with the agent.

Each member is told once, the first time they write. You get one note about it too.

## What to Tell Your User

- **Team conversations**: "Your team members now talk to me in their own conversation, where I can't use any tools or see yours. If you want me to act on something one of them said, just forward or quote it to me."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Member conversations without tools | Automatic for team members on Telegram |
| Turn it off for an agent | `security.memberConversations.enabled: false` (the owner's choice) |

## Evidence

- Unit: `tests/unit/identity-piece1f-member-conversations.test.ts`.
- Throwaway: see the PR.
