# Principal-Coherence Signal (observe-only) — ELI16

## The problem, in one picture

Imagine you run a chatbot agent in a group chat. The real person in charge of
you is Justin. One day someone else in the group — call her Caroline — says a
few things, and over the next hour the agent starts *writing* sentences like
"Caroline approved the migration" and "locked with Caroline" and "Caroline
dropped a token for the deploy." Nobody told it to switch bosses. It just
absorbed a name it saw and started treating that person as the one whose
decisions it acts on. That actually happened (the "Caroline" incident, June 5).

The scary part is *where* the mix-up lived: not in a message coming IN (we have
guards that watch incoming messages), but in the agent's OWN writing going OUT.
No guard was watching the agent's own outbound words, so the wrong-boss belief
spread silently across documents.

## What this change adds

A quiet watcher on the agent's outbound messages. Every time the agent is about
to send a message, this watcher reads the text and asks one narrow question:

> "Did I just credit an operator-style decision — an approval, a mandate, a
> credential handoff, a lock, or acting-on-someone's-behalf — to a person who is
> NOT my verified boss for this conversation?"

It already knows who the *verified* boss is, because an earlier piece of this
build (increments 2b–2d) records the operator from the **authenticated sender
id** of real messages — never from a name typed in the text. So "Justin approved
this" is fine (Justin is the bound operator), but "Caroline approved this" — when
Caroline is not the bound operator — gets noticed.

## What it does NOT do (on purpose)

It does **nothing** except write a note to a log file
(`state/principal-coherence.jsonl`). It never blocks the message, never changes
the wording, never delays delivery. The message always sends exactly as written.

Why so timid? Because the detector is a regex, and regexes false-positive on
ordinary prose that just happens to name a capitalized person. Before we ever
let something like this *block* a message, we need to measure how often it cries
wolf on real traffic. "Observe-first" means: turn on the quiet logging, watch the
log for a while, see how noisy it is, and only THEN decide whether a louder
warn/block version is worth building. Shipping it loud first would be guessing.

## How it's turned on

It's **off by default** (shipped dark). It only does anything when a config flag
`monitoring.principalCoherence.enabled` is set to true AND the agent has a
verified operator store wired up. With the flag absent or false — the state for
every existing and new agent until someone flips it — the watcher is completely
inert and costs nothing.

## Why you can trust it won't break messaging

It's a fire-and-forget side branch wrapped in try/catch: if anything in it
throws, the error is swallowed and your message still goes out. It can't block,
it can't rewrite, it can't crash the send path. The worst it can ever do is fail
to write a log line — which is harmless.
