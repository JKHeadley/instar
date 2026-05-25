# Plain-English overview — one shelf instead of three

## The one-sentence version

Right now I keep "what's relevant" in three separate notebooks that don't talk to
each other. This makes one ranked reading list that pulls from all three, so when
I sit down I get *one* sorted view of what matters — not three half-answers.

## Why this matters (the three-notebooks analogy)

Imagine you kept your to-do reminders in three different notebooks: one for facts
from conversations, one for handy reference cards, one for longer-term knowledge.
Each notebook sorts itself its own way. When you start your day, you'd have to
flip through all three and mentally merge them. That's me today.

This change adds a front page that reads all three notebooks and gives me one
ranked list — most-relevant first, faded stuff dropping off the bottom (but not
thrown away; it comes back the moment it's mentioned again).

## The important, non-obvious part

I am NOT proposing to dump all three notebooks into one big database and shuffle
everyone's pages around — that's a huge, risky move for little gain. Instead, I
already have a thing called the "assembler" that, at the start of a session, pulls
together the right context within a budget. It pulls from *some* of the
notebooks today. This change just teaches it to also pull from the other two and
rank everything together. The notebooks stay where they are; the *reading* is
what gets unified.

That's the load-bearing choice I want you to confirm: **unify the reading, leave
the storage alone.** It's additive, reversible, and doesn't touch your existing
data.

## What it does, concretely

1. Defines a common "card" shape so an item from any notebook looks the same to
   the ranker (a bit of text, how relevant, how recent, where it came from).
2. Ranks all the cards together (relevance, with older stuff gently sinking), then
   fills the context up to a budget — same budgeting the assembler already does.
3. Each notebook keeps its own sense of how fast things fade; the ranker just
   blends them, it doesn't overrule them.
4. Keeps score of which notebook contributed what, so we can see if the blend is
   actually better and tune it.

A safety promise built in: if the new notebooks are empty, what I assemble is
*exactly* what I assemble today — so this can't quietly change existing behavior.

## What I want from you

This is the **ratification gate** — your sign-off before I build. The big one:

- **(A)** Unify the *reading* (extend the assembler) — my strong pick — vs. merge
  the actual storage and migrate data (much riskier, little upside).
- **(B)** The exact ranking formula + how much room each notebook gets — starting
  guesses, tunable later.
- **(C)** Keep each notebook's own filtering inside that notebook (my pick) vs.
  move it into the ranker.

## One honest caveat

This is the biggest, most structural step yet — it touches the shared assembler
lots of things read from. I wrote and self-reviewed it, but the full multi-model
review tooling isn't on this machine, so a fuller review before the code merges is
especially worth it here. "Approved" means "direction's right, go build."
