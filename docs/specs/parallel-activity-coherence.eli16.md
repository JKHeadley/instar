# ELI16 — Parallel-Work Awareness (overlap councilor)

## What this is, in plain English

When an agent runs across many Telegram topics at once, it can lose track of what its
"other hands" are doing. The real example that motivated this: in one topic I started
designing CPU/memory tracking with no idea that a different topic had already finished
that exact work — the user had to point it out. This feature gives the agent a quiet
councilor that notices "hey, two of your topics are working on the same thing" and tells
the agent, so it can align instead of duplicating.

## The big thing the design review changed

My first draft was going to BUILD a new store that records what each topic is working on.
The reviewers (reading the actual code) found that store **already exists** — it's the
"Topic Intent" layer, which already records each topic's focus and goals, already updates
itself on every conversation turn (no remembering required), and already has a decay/
freshness mechanism. Building a second one would have been pure duplication — and ironically
would have been the *same* blindness this feature is supposed to cure.

So the design shrank: instead of a new store, the genuinely-new part is just (a) a thin
"list all my topics and what each is working on" view over the existing data, and (b) the
part that actually compares topics to each other to spot overlap — which truly doesn't
exist yet. That comparison-and-nudge is the real feature.

## The other things the review caught

- **There is no single "active topic."** The agent runs many topics at once (and across
  machines). So the sentinel compares the *set* of currently-running topics against each
  other, never against itself, and only the lease-holding machine runs it (so you don't get
  nudged twice).
- **A naive overlap check would be unbearably noisy.** Two topics that both say "fix the
  test" share generic words and would trigger a false "you're duplicating!" alarm — which
  you'd mute within a day. So the check ignores boilerplate words, weights rare/specific
  words (a shared "resourceledger" matters; a shared "cpu" or "fix" doesn't), requires at
  least one genuinely specific shared term, and caps how often it can nudge.
- **Naming collision.** "Coherence" already means three different things in the codebase
  (a gate, a monitor, a reviewer). So this is named ParallelWorkSentinel under a fresh
  /parallel-work path, not "Coherence Sentinel," to keep things clear.

## What you actually need to decide

You already approved the direction and asked for a proactive sentinel (not a thing the
agent has to remember to check). Convergence kept that and made it cheaper + non-duplicative.
It ships in two PRs: first the cross-topic view, then the overlap sentinel — and the sentinel
ships **dark** (off by default) because a false-positive nudge is worse than silence, so it
gets switched on only after it's proven quiet.

## Safeguards in plain terms

- Off by default for the noisy part; the read-only view changes nothing on its own.
- It only signals — it never blocks or changes any work.
- It reuses existing storage, so there's no new data to migrate and nothing to roll back
  beyond deleting a config flag.
