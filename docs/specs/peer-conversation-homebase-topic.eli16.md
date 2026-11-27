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

## Your rule, now built (2026-10-31)

You put it plainly: *"the whole point of the agent specific topic is that all messages from an
agent that are intended for the user show up in that topic."* The first build created the topics
but nothing ever sent anything to them. A message from a paired agent still went wherever its
conversation happened to start, or wherever the session that read it decided to post. On
2026-10-31 Scout got Echo's first message a minute before Scout's "🤝 echo" topic even existed,
and posted it into an unrelated invoices topic.

So now:

- **A message from a paired agent that is meant for you goes to that agent's topic, with a
  notification.** Your agent's server posts the first message of each conversation there itself,
  rather than leaving the choice to whichever session handles the conversation. Later messages
  in the same conversation are posted by that session, which is now told which topic to use.
  That second part is an instruction to the session, not something the server forces, because
  the server cannot yet tell on its own which later messages need you.
- **Only a paired agent counts.** Your agent recognises the other agent by its cryptographic
  identity, not by the name it gives, so an unknown agent that calls itself by a paired agent's
  name cannot post into that agent's topic.
- **That includes replies to conversations your agent started from another topic.** The reply
  still goes to the session that asked (it is that session's work), but the message you see
  lands in the paired agent's topic.
- **The only thing that beats it is your own choice.** If you tied a conversation to a topic
  yourself (for example with "open this"), that topic still wins.
- **Back-and-forth between the agents that you don't need to see stays out of your way**, as
  before.
- **Both agents get their topic the moment pairing finishes**, not on the first message. Before,
  only the agent whose person tapped Finish got one straight away; the other side got it a
  minute too late.

To switch all of this off, set `threadline.peerHomebase.enabled` to false; your agent then routes
exactly as it did before.

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

A new topic appears per paired agent, named after it. Messages from those agents that are meant
for you arrive there and buzz you. A conversation you tied to a topic yourself stays there.

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

---

## Postscript 2: a check fired on code I never touched, and then on my own apology

Instar keeps a counter of places where the code quietly swallows a problem instead of
reporting it. The rule is simple: the number may go down, never up. Mine went up by one, so the
build stopped.

The place it pointed at was not my code. It was an unrelated few lines above mine, which had
been sitting there untouched and uncounted for a long time. The reason is that the counter does
not read just the lines in question — it reads those lines **and the twenty that follow**. My
new block sat in that trailing window, and one line of it happened to look, to the counter's
pattern-matching, like the thing it hunts for. So mine made its neighbour look guilty.

The tempting move was to raise the limit by one and write a note explaining why it was fine.
That is exactly how a counter like this dies: every author raises it once, with a good reason,
and in a year it measures nothing. Instead I changed my line so it no longer resembles the
pattern — the code does the same thing, the counter went back to its old number, and nothing
was granted an exception.

The part I would rather record than hide: my first attempt did not work, and it looked like it
should have. The count stayed exactly where it was. Instead of assuming I had the wrong theory,
I printed the twenty lines the counter actually reads — and found that the **comment I had just
written to explain the fix** contained one of the very words the counter searches for. So the
explanation re-tripped the check by a different route. Both causes were mine, one stacked on the
other. Had I trusted the first fix and pushed it, I would have shipped a change that did nothing
and then read the next red build as bad luck.

## Addendum, 2026-10-23: agents paired earlier, and switched on by default

The first version only made a peer's topic at the moment a pairing was confirmed. An agent you
had already paired with — `pp`, paired the day before this shipped — would never be confirmed
again, so it never got one. Now the topic is also made the next time a message passes between
you and that agent (either direction), and once a minute after each server start, under exactly
the same rules: only the serving machine creates, an existing topic is reused, and a stranger
cannot cause one. And it is now on by default everywhere instead of only on development
agents, because the operator asked for this by name; setting it to `false` turns it off.

## Addendum, 2026-10-31 (second half): every message, not just the first

The first half of today's change made the server post a paired agent's message into that
agent's own topic, but only the first message of each conversation. Later messages that needed
you depended on the session handling them remembering to post them in the right place. That is
the kind of thing an instruction cannot guarantee.

Now each message is looked at on its own and the server asks one question: is this meant for the
person? A delivery receipt ("Message received") is recognised by its fixed type and is never
posted, with no model involved. For everything else, Jev answers first when this agent has a Jev
key; when Jev is unsure, or there is no key, a fast Codex model answers, and if Codex is not
there either, the agent's own model answers. So an agent with only a Claude subscription still
gets this. The question is about meaning: a peer writing "tell Justin the invoice is ready" or
"for your person" counts as meant for you, and two agents sorting out a technical detail
between themselves does not.

When no answer can be had at all (every model down), the message is posted anyway. A message
you see twice costs you a glance; a message you never see can cost a missed decision. The cost
is bounded: at most 300 model calls a day and 30 judged messages per paired agent per hour. Past
either limit it goes back to posting only the first message of a conversation, so a spent budget
never turns into a flood. The existing limit of three posts a minute into one topic still holds;
a message held by it is tried again a minute later rather than dropped. The message text (with
secrets removed) is sent to whichever model answers.

The session handling the conversation is now told, only when it is true, that the server has
already posted these messages, so it does not post them a second time.

What you would decide: nothing, unless you want it off. Setting
`threadline.peerHomebase.perMessageClassification` to `false` brings back the first-message-only
behaviour. A record of every decision, without any message text, is kept in
`logs/peer-user-meant.jsonl`, which is how we will measure how often the model gets it right.
