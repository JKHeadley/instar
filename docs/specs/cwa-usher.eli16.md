# Plain-English overview — the helpful nudge, earned before it's allowed to interrupt

## The one-sentence version

I now remember things and keep them in one ranked list — but I only *look* at that
list at two moments: when a session starts and right before I send a message. The
Usher watches the whole time, and when something I'd filed-away suddenly matters
again, it raises its hand — quietly, on a side board, not in your face.

## Why this matters (the usher analogy)

Think of an usher in a theatre. They don't grab you and drag you to your seat —
they stand at the side, notice when you look lost, and quietly point. That's
exactly the posture here: as our conversation moves, the Usher notices "hey, that
thing we decided three topics ago is relevant to what's happening right now" and
flags it on a side board I (or you) can glance at.

The thing I forgot in the original incident — "we're testing over Telegram" —
faded out of view mid-task. A briefing at the start wouldn't have caught it,
because it only became relevant *later*. The Usher is the piece that catches
exactly that "it matters again now" moment.

## The most important part: it can't interrupt yet, on purpose

A watcher that's allowed to interrupt is the fastest way to become the thing you
learn to ignore. So the Usher starts **signal-only**: it writes its suggestions to
a side board (a page you pull up), never pushes them into the chat, and never
forces them into my thinking. 

And here's the structural promise: before we EVER let it actually interrupt me
mid-task (that's the next step, rung 5), we **measure how often its nudges were
genuinely useful versus noise**. If it's not accurate, it doesn't get promoted.
The data has to earn the right to interrupt. We even tie it to the
"human-as-detector" heat map from earlier — every time *you* have to say "you
forgot X," that's logged as a nudge the Usher *should* have raised and didn't.

## What it does, concretely

1. On each real message, it does one cheap check: "did this just make something
   we'd set aside relevant again?"
2. If yes, it posts a quiet suggestion to a side board (`/usher/signals`) — the
   faded thing + why it might matter now.
3. It keeps score: how many nudges it raised, how many turned out useful, and
   (via the heat map) what it missed. That score is the gate for rung 5.
4. It can never block or slow a reply, and if anything's unavailable it simply
   stays quiet.

## What I want from you

This is the **ratification gate**. Three calls I made (details in the spec):

- **(A)** Watch on each message (my pick — cheap, mid-conversation = mid-task) vs.
  on every single tool-step (much pricier).
- **(B)** A dedicated side board for Usher nudges (my pick — keeps its accuracy
  measurable on its own) vs. folding into the existing attention list.
- **(C)** "Faded" means stuff that dropped off the start-of-session briefing (my
  pick — the genuine "it's back" case) vs. everything.

## One honest caveat

I wrote and self-reviewed this; the full multi-model review tooling isn't on this
machine. The Usher is deliberately the *safe* half of the idea (it only suggests,
on a side board, and has to prove itself before it's allowed to interrupt) — but a
fuller review before the code merges is still worth it, especially on how we
define "was this nudge useful," since that number is what unlocks the next step.
