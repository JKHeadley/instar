# Threadline Conversation Keystone (Phase 1) — Plain-English Overview

## What this is

The first, foundational piece of the Threadline redesign you approved. It fixes
the two real bugs we hit — conversations fragmenting into stray side-sessions,
and two agents echoing "thanks → thanks" forever — without yet changing the
bigger "how does an agent reply" model (that's Phase 2, already tracked so it
can't be forgotten).

## The three pieces

**1. One "conversation" record as the single source of truth.** Right now the
facts about a conversation are scattered across four different lists that can
disagree. We replace them with one record per conversation that knows: who's
talking, which session/topic it belongs to, how many turns have happened, and
whether anything new was actually said. Everything reads and writes just this.

**2. Bind the conversation to its session/topic automatically.** Today a message
only stays glued to the right place if whoever sent it remembered to tag it —
and when they forget, it floats off into a brand-new stray session (that's the
fragmentation bug). We move that tagging to the moment a session is created,
where the system already knows the context, so it happens every time without
anyone remembering. And we add a hard rule: if an incoming message belongs to a
conversation that already has a home, it goes THERE — never a new stray session.

**3. A "does this even need a reply?" check before the agent answers.** Today the
agent replies to literally everything, including a bare "thanks" — which is how
the infinite loop happens. We add a quick check: a real question or request
always gets answered (it stays snappy), but a content-free acknowledgement with
nothing new doesn't trigger a reply. Plus a backstop: if two agents go back and
forth with nothing new being said, it winds down after a couple of turns —
while a genuinely productive long conversation, where each turn adds something,
never trips it. Conversations with a human in them are exempt and stay instant.

## Why this shape

The root cause of both bugs is that the little one-shot helper an agent spins up
to reply has no memory and no awareness — it can't know "we're in turn 12 of a
loop." So the memory has to live on the conversation record, not the helper.
That's the keystone everything else builds on.

## Safeguards

Nothing here adds a brittle new gatekeeper that blocks things — the cheap checks
just raise a flag, and the only thing that suppresses a reply is a careful
classifier that always errs toward answering. It's reversible (the new record is
additive; existing conversations are migrated over, not lost), and it goes
through the full test + review gate.

## What you're deciding

Just whether to approve building this Phase 1 keystone. It dissolves the two
failures you saw, and it's mostly tidying things that already exist (four lists →
one record) plus the missing reply-check. Phase 2 (the inbox model) is already
tracked as a commitment so it won't fall through the cracks.
