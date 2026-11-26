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

## Addendum, 2026-10-14 — the index now sees what a topic is DOING, and the councilor can prove it is running

**What went wrong.** The cross-topic view only knew what each conversation had *talked
about*. It did not know what a session was *doing*. So on 2026-10-14 one session told the
operator to hold off on restarting the Mac Studio, a different session asked him to
approve that same restart two hours later, and the first session never knew — its view of
the second topic still showed a goal written 21 minutes before the restart was proposed.
Separately, the "are two topics overlapping?" watcher was switched on but nothing anywhere
could confirm it had ever run.

**What changes.** The moment one of the agent's replies says it is about to do something
concrete ("I'll restart it", "pushing the fix") *or asks the operator to approve something*
("may I restart the Studio?", "please approve the restart"), a small note is saved for that
topic automatically — no session has to remember to post anything. The cross-topic view
shows that note immediately as the topic's current focus and as a `lastAction` field. A
sibling session that reads the view before advising on a restart now sees "topic 102965
asked the operator to approve: restart, at 14:34" instead of a stale goal.

The overlap watcher now counts its own runs and reports its last run time, so the guard
inventory grades it "on, confirmed" from a real tick instead of "on, unverified" forever.
There is also a small read-only status page for it.

**What it does not do.** It never blocks a message, never opens a commitment for an
approval request (asking is not promising), never changes what the operator sees, and
never guesses: a note that is not newer than the latest conversational goal does not
replace it, and notes fade out of the focus after a day. Off switch:
`parallelWork.actionNotes.enabled: false`, read live.
