# ELI16 — a quiet watcher that notices when I try to hand you back work I could do myself

## The problem this fixes

There's a specific way I let you down that nothing was catching. At the end of a turn I'd sometimes
write something like "I've stopped here — want me to line that up, or would you rather steer me
elsewhere?" — handing YOU a decision about work that I could actually just do myself. It sounds polite
and reasonable, so none of the existing guards flagged it: it wasn't a routed message, it didn't match
any banned phrase, and it ended with a real-sounding question that the meaning-based rules are told to
let through. The one check smart enough to catch it (a meaning-based judge) wasn't watching the
turn-end surface at all, and outside an autonomous run there was no always-on "could you do this
yourself?" check anywhere.

## What this change adds (and, just as important, what it does NOT do)

It puts a meaning-based judge on the turn-end surface that, on every finished turn, quietly asks: "did
this message hand the operator a decision about work the agent could do within its own means?" It reads
a little recent conversation (your last few messages) so it can tell a genuine "your call" (taste,
priority, a credential only you have) apart from me punting work I should just do. It writes down what
it saw.

Crucially, in this phase it **blocks nothing**. It never stops a message, never delays a turn, never
changes what I say. It only records — so we can measure how often it fires and how accurate it is
before ever deciding whether to let it actively intervene. That "actively stop me" version is a
separate, deliberately-deferred piece of work with its own hard design questions (chiefly: how to make
it impossible for me to quietly switch off or game, and how to guarantee it never wrongly blocks you).

## Why it's safe

- **It cannot wedge a turn.** It rides the single check that already runs at every turn-end (no new
  model call, no second judge), it only adds fields on the "allow" path, and it never touches the
  blocking logic. Every message still ends exactly as it would have.
- **The context read can't hang me.** Reading your recent turns is a bounded, fail-open tail-read: it
  scans at most a small slice from the end of the transcript, caps each turn's length, and on anything
  weird (missing file, giant line, bad data) it simply proceeds with no context instead of erroring.
- **It's off on the fleet by default.** It only turns on for a development agent (me), so it soaks on
  one agent first. When off, nothing is recorded and the base behavior is byte-for-byte unchanged —
  I even proved the shared judge prompt is untouched when the feature is off.
- **It's reversible.** No blocking, and the only new state is extra columns in an existing local
  telemetry database (with a real prune so it can't grow forever) — turning the flag off stops it cold.

## How we know it works

Fifty-five tests across five new suites: the classifier catches a real self-deferral and correctly lets
a genuine "your call" through; the tricky case (a design-question shape that's actually me punting
doable work) resolves the right way; the existing rules' verdicts are proven unchanged by the prompt
edit; the database migration adds its columns idempotently on an old database and prunes old rows; and
the transcript reader stays bounded and never throws on bad input.
