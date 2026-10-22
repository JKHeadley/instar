# Plain English — give each paired agent its own topic

## What went wrong

You asked another agent, `pp`, to get your agent to contact you. It said it had. You saw nothing
useful, because the notice landed in a conversation about Claude quota.

That wasn't a coincidence. When your agent starts talking to another agent, the conversation
quietly adopts whatever Telegram topic the thread happened to begin in, and keeps it forever.
So a message about `pp` went wherever the `pp` thread first happened to start. The misdelivery
was the bug; the missing topic was just what made it invisible.

## What this changes

Four small things.

1. **When your agent finishes pairing with another agent, it creates a topic for that agent**,
   named after it, with a few characters of its identity on the end so two agents with the same
   name can't share one. One topic per paired agent.
2. **That agent's conversation gets pointed at that topic** — unless you had already pointed it
   somewhere yourself, in which case your choice stands. Always. Including for conversations
   from before this existed, where your agent can't tell whether you chose the topic or it was
   inherited by accident: in that case it leaves it alone and waits for you to say.
3. **The accidental inheritance is removed**, so this can't happen again to a new conversation.
4. **When a paired agent asks for you**, that message arrives with a notification, in the topic
   your rules select — so "please contact your operator" reaches you instead of sitting in a
   quota conversation.

## What it deliberately does not do

This is the short version on purpose. The first version of this design ran twenty-one review
rounds and became a document about crash recovery, cryptographically proving which agent opened
a Telegram topic, and reconciling duplicate topics. You stopped it, and you were right to: that
is long-tail engineering for a feature whose job is "put the notices somewhere I can find them."

So the risks that version removed are now simply accepted, and written down:

- If your agent crashes in the half-second between creating a topic and remembering it, **and**
  the other agent changed its display name before the retry, you could end up with two similar
  topics. You'd notice; deleting one is easy.
- A topic is recognised by its **name**. If you made a topic with exactly that name yourself,
  your agent would use it. In your own forum, that's fine.
- A peer paired before this ships gets its topic the next time pairing is re-verified, or when
  you ask. There's no sweep that goes back over old ones.
- If creating the topic fails, nothing is bound and the failure is logged; the next verification
  tries again. Nobody chases it.

Each of those is written in the spec's "left behind" list with the risk named, so it is a
decision on record rather than something nobody thought about.

## What you'd notice

A new topic appears per paired agent, named after it. Requests from those agents arrive there
and buzz you. Anything you'd already filed somewhere stays where you put it.
