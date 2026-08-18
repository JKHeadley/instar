# Duplicate-session stand-down — the plain-English version

## What this is

Sometimes two of Justin's machines end up both running a live copy of me for the same
conversation. Two copies answer the same messages, trip over each other, and cause the stalls
and "session stopped" churn he saw on 2026-08-17. The system already works out correctly which
copy should win — but the only tool it had for the losing copy was a force-kill, and a safety
rule (rightly) refuses to force-kill a busy session. A duplicate is always busy, because it's
busy doing the duplicate work. Stalemate: the wrong copy survives until a human kills it.

We designed a force-kill that could get past the safety rule, reviewed it, and the review
rejected it: in a split-brain both machines could kill their own copy at once (conversation
dead everywhere); a successful kill resets the brakes, so an undiagnosed cause becomes an
endless kill-and-respawn loop; and it could cut a session off mid-answer. Justin chose the
alternative: the stand-down.

## What we're building

The losing copy is told to STAND DOWN, not die:

- It cannot start any NEW work. A pre-existing hook mechanism blocks new tool calls — every
  kind: running commands, editing files, launching helpers, fetching the web. Only pure
  reading stays allowed, and anything unknown is blocked by default. (The first draft
  forgot file edits; review caught it.)
- It cannot send the user any MORE messages — the message pipeline refuses its sends with a
  logged reason, and that refusal never turns into a false "couldn't deliver" alert.
- The step already in flight completes. Nothing is destroyed, ever.
- Once genuinely quiet, an explicit, narrow close rule ends the session. (The first draft
  claimed the existing cleanup would do this for free; review proved that cleanup doesn't
  run at all on an unstressed machine, so we now say honestly: this is one new, tightly
  fenced exception to the keep-alive rules — the single exception three past patches were
  each groping toward.)

Three important refinements the review forced:

- **A copy holding real work is never muzzled.** If the losing copy is mid-build or running
  helpers, freezing it would strand that work — so instead the human gets one notification
  and decides. And if it's running an autonomous job, the job is first suspended cleanly at
  a step boundary (a mechanism we already ship), then the stand-down proceeds.
- **No message is silently swallowed.** If the muzzled copy holds an unanswered message from
  the user, it's re-routed to the winning machine; if the user writes to the muzzled copy
  again, either the message is diverted to the winner (with one short heads-up) or — if the
  winner is unreachable — the muzzle is lifted and this copy answers. An unreachable agent
  is always the worse outcome, so every tie breaks toward answering.
- **No loops.** Every repeat-cycle the reviewers could construct (muzzle-release-muzzle
  oscillation, hourly re-muzzling after a timeout) is blocked by a one-per-episode latch:
  once an episode is adjudicated, it can't repeat without genuinely new evidence.

If a muzzled copy hasn't gone quiet after an hour, nothing violent happens: its voice stays
off, one notification asks Justin what to do, once. Destruction always requires a human.

## Honest limits

- The tool-blocking half works fully for Claude-code sessions today. Codex/Gemini/Pi copies
  get the voice muzzle immediately but not the tool block in v1 — declared, with the codex
  hook as a tracked follow-up.
- During a genuine network partition, "exactly one copy speaks" can't be guaranteed; we
  choose "at least one copy speaks" and accept a brief possibility of two, which is exactly
  today's condition — never worse.

## Safety posture

Ships dark on the fleet, observation-only first even on the dev machine: it logs what it
WOULD have blocked so we can measure false positives before anything is actually muzzled.
The switch from observing to enforcing is Justin's, on that evidence. One-line off switch
returns everything to today's behaviour. It never kills anything — the worst it can do is
make a duplicate go quiet, and even that self-reverses if the ownership records say it was
wrong.

## What Justin needs to decide

Nothing new — he chose this direction on 2026-08-17. Approving this spec means: build it as
described. Tuning numbers (the one-hour patience window, the quiet-check counts) are
deliberately changeable later without another review.

## What changed between approval and shipping (post-approval note, 2026-08-18)

The build went through five independent adversarial review rounds plus a closing
verification pass: 48 findings, all fixed, none found by the author. Three would have
made the feature silently inert (a wrong file path, a wrong credential, a counter that
counted requests instead of completions); one round-4 cluster would have inverted the
safety promise and let a genuinely working session be closed. Every fix carries a
regression test that derives its expected values from the production code rather than
restating them — the lesson of this build is that a hand-written test value is free to
agree with broken code.

Two honest scope notes that were NOT in the approved draft: Slack-bound duplicates are
not covered in v1 (neither muzzle half — declared and tracked, alongside the already-
declared non-Claude-framework gap), and the tool-muzzle requires the session to have
been spawned by instar (which is how every real session starts). Nothing in the approved
behaviour changed; the review made the claims match the code.
