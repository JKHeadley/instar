# Telegram issues group — plain-English overview

## What this is

Right now every conversation an Instar agent has with its operator lives in one
Telegram group, split into topics. When the agent finds a serious problem while
working, the triage rule tells it to open a separate topic for that problem and start
a new session to fix it. Those bug topics pile up next to the everyday conversations,
and the topic list gets cluttered.

This change lets an agent have a second Telegram group, just for bug topics. For Echo
it is called "Echo Bugs". The main group keeps the conversations; the bugs group keeps
the problems.

## What already exists

- One Telegram group per agent, set by one number in the agent's config.
- Topics inside it, each one tied to a session.
- A way for the agent to create a topic (`POST /telegram/topics`).
- One background process (the lifeline) that reads every message the bot receives,
  from every group the bot is in.

## What is new

- One optional config value: the id of the bugs group. Leave it out and nothing
  changes.
- Inside Instar, a topic number has to point at exactly one place. Telegram reuses
  topic numbers in each group, so topic 5 in the bugs group and topic 5 in the main
  group would clash. To avoid that, bugs-group topics get a big number added to
  them (ten billion) inside Instar. Topic 5 in "Echo Bugs" becomes topic
  10,000,000,005 inside Instar. Real Telegram topic numbers never get that big, so
  nothing can clash.
- The translation happens only where Instar talks to Telegram: when a message comes
  in, and when one goes out. Everything else (sessions, reminders, the reply script)
  just sees a topic number, like today.
- When the agent creates a topic and says it is an issue (`"kind":"issue"`), it is
  made in the bugs group.
- The safety check that refuses to send to unknown chats is told that the bugs group
  is allowed.

## Safeguards

- If the bugs group is not configured, every new piece of code does nothing.
- The only safety check changed only gains one allowed chat, which the operator set
  up themselves. Nothing that was allowed before is now refused, and foreign chats are
  still refused.
- Turning it off is removing one config value.

## What the reader needs to decide

Nothing beyond "yes, separate bug topics from conversations". The group itself is
created by the agent from the operator's signed-in Telegram, so the operator has no
setup chore.
