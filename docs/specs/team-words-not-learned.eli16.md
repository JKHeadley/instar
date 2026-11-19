# Only your own words teach your agent your preferences — plain-English overview

## What this is

Your agent learns your preferences from the corrections you give it in conversation, and uses them in every later session. If you add team members, they can message the agent too. Their words were supposed to be kept out of what the agent learns about you, but a label marking a message as "from a team member" was lost one step before the learning part looked for it.

## What changes

The label is now kept, and one rule decides what counts as your own words everywhere the agent learns. It starts from you rather than from a list of who to leave out: a message counts only if it came from you (your own Telegram account, or your own phone in the app) and is not text you forwarded from someone else. Team members, a phone that belongs to someone else, other people in a shared chat and messages whose sender could not be confirmed never count. When a team member's message sits next to yours in the conversation, the agent still sees it for context, but it is marked as not yours, so nothing is learned from it as your preference.

## What you would notice

Nothing in how you talk to your agent. What it learns about your preferences now comes only from you.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
