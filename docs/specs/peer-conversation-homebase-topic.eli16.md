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

## Which rule this serves

Instar's standards list has an article called *The User Experience Is the Product —
Reachability, Responsiveness, and Coherence Are Sacred*. Its rule is that your ability to reach
your agent, **be heard**, and get a coherent answer outranks the agent's own internal caution
when the two conflict.

This is the "be heard" half, and the incident is a clean example of failing it without anything
looking broken. The message was sent. Delivery succeeded. No error was raised anywhere. It just
arrived somewhere you had no reason to look, so the only way you found out was by noticing an
absence and asking — which is you doing the agent's job.

One standard points the other way and is worth naming: *Notices Route to the Alerts Topic, Never
a New One* exists because an agent creating its own notification topics once flooded you. This
feature takes a deliberate, recorded exception to it, because you asked for these topics and one
per paired agent is a set you want. That exception is written into the spec with your own words
next to it, so nobody later mistakes it for an oversight.

---

## Postscript: the card almost only reached one kind of agent

After the first four pieces merged, CI stopped the fifth with a complaint that sounds like
paperwork and is not. Instar keeps two lists whose only job is to ask "did this capability
actually reach everyone?" The new explanation of where a peer's notices go had been written
into the file a fresh agent gets, and into the upgrade step an existing agent runs — but not
into either list. One of those lists is what copies an explanation across to agents running on
a different engine (Codex, Gemini) instead of Claude.

So the fix would have shipped, worked, and still left a whole class of agents not knowing the
topic existed. Those agents would have gone on saying "I passed your message on" while posting
it where you had no reason to look — which is precisely the thing this feature was built to
stop. The feature would have been installed and the incident would have kept happening, in the
one place nobody would think to check.

Two details are worth keeping because they are easy to get subtly wrong. The first list
compares *exactly* against the phrase the upgrade step searches for, so it has to hold the bare
phrase. The second list is not a label but a bookmark: the code finds that text in the file and
copies from there onward, so it has to hold the whole heading, or the copy would arrive as a
paragraph with its title missing. The bare phrase is contained inside the heading, so the two
stay in agreement on their own rather than relying on someone remembering to update both.

The honest lesson is smaller than the fix: the tests for this feature all passed. The guard
that caught this lives in a different file, measuring something the feature's own tests were
never going to ask.
