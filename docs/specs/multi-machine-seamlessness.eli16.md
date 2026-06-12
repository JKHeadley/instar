# Multi-Machine Seamlessness — Plain-English Overview

## The problem, in one story

You asked one simple thing of the multi-machine project: "talking to my agent should
feel like talking to ONE being, no matter how many computers it lives on." Today we
tested that promise by moving a live conversation from the laptop to the Mac Mini —
and the seams showed. The paperwork moved instantly (every machine agreed the Mini now
owned the conversation), but your messages kept landing on the laptop, the laptop kept
answering, and the system spent the next hour politely trying to close the laptop's
copy every two minutes while it was actively working. The move flipped a label, not
the conversation.

We then audited EVERYTHING with that same question — "where else does the seam show?"
— and found about twenty places. They group into five families.

## The five families of seams

**1. The conversation doesn't actually follow the move.** Message delivery never asks
"which machine owns this conversation?" — it just hands the message to whatever copy
is closest. Fix: delivery consults ownership first; a move of a busy conversation
becomes a polite handoff (finish the sentence, pass the baton) instead of an endless
tug-of-war. A half-moved state becomes honest and visible instead of silently stuck.

**2. The agent's memory doesn't follow you.** What I've learned about you — your
preferences, the corrections you've given me, who the people in your life are, the
knowledge base you've built with me — all of it lives on whichever machine learned it.
After a handoff I'd partially forget who you are. Fix: those memories replicate
between machines over the same encrypted channel secrets already use, with careful
merging when both machines learned something at once.

**3. Two machines, one mouth.** Some of my background voices (the "I'm still working
on it" standby notices) don't check which machine should speak — both machines could
answer you about the same conversation, or each could assume the other will and
neither speaks. Fix: exactly one machine speaks for each conversation, the same rule
my promise-reminders already follow.

**4. One pane of glass, some panes missing.** The dashboard now shows sessions and
safety systems across all machines — but attention items (things needing your
decision) are still per-machine, scheduled jobs have no cross-machine view, links to
private pages break if the content lives on the other machine, and an idle machine
looks identical to a broken one. Fix: merge those views the same way sessions were
merged, make links work regardless of which machine holds the content, and say
"online — nothing running" out loud.

**5. The account cushion doesn't travel.** The laptop holds your 5-account
subscription pool; the Mini has one login and no fallback at a quota wall. Fix, in two
careful steps: first make the pool's depth visible everywhere and let placement prefer
machines with cushion; later (with its own security review) make enrolling an account
onto another machine a one-tap flow — never by copying login files around.

## What the review process is for

This spec went through the full multi-reviewer convergence gauntlet (security,
scalability, adversarial, integration, lessons-learned, plus an outside AI model)
before any code gets written. The review's job is to catch the "cure becomes the
disease" failures: a message forwarded to the wrong machine, two machines merging your
preferences with skewed clocks, a proxy that quietly overloads the one machine
fronting your dashboard.

## What changes for you when it ships

Nothing, at first — every piece ships dark behind its own switch, with dry-run modes
for the correctness-critical parts, and a single-machine setup is untouched by all of
it. As pieces graduate: moving a conversation between machines will actually move it
(and tell you honestly while it's mid-move), I'll remember you identically on every
machine, exactly one voice will answer, the dashboard becomes genuinely one pane of
glass, and quota walls stop being a single-machine problem.

## Open questions (decided by default, flag if you disagree)

1. Cross-machine message forwarding rides the same internal lane machine-moves already
   use (simplest, proven) — not a new channel.
2. If both machines learned conflicting things about the same person during a network
   split, the newer fact wins field-by-field and the conflict is flagged in your daily
   digest rather than silently discarded.
3. Links keep ONE address (your existing dashboard hostname); the fronting machine
   quietly fetches content from whichever machine holds it.
4. Account-cushion awareness only breaks ties in placement at first — it never
   overrides load-balancing on its own.

## The honest costs

Replicating memories means more disk and network between your machines (bounded, with
caps and compaction). The one-address link design concentrates traffic on the fronting
machine (streamed, capped, and it can be revisited). And the account-enrollment
follow-me is deliberately deferred to its own security review — the convenience is not
worth rushing credentials handling.

## Shipped so far

- **One pane of glass, first piece** (WS4.2, PR #1083): the dashboard now labels
  every machine honestly — "online — no active sessions" vs "not reachable".
- **One voice** (WS3.1/3.2, this change): exactly one machine speaks each
  conversation's background notices — never two, and never zero (unknown ownership
  falls back to a deterministic speaker rather than silence). Dark behind
  `multiMachine.seamlessness.ws3OneVoice`; single-machine setups untouched.
