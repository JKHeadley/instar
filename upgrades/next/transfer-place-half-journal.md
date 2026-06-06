# Transfer PLACE-half journaling — quiet-topic moves carry their ownership proof

## What Changed

`POST /pool/transfer` of a QUIET topic (never-seen or released ownership
record) previously journaled NOTHING: the placement pin is router-local and
the handler's release half only fires when the router itself held ownership.
The pinned-to machine therefore could never prove the topic was its to serve —
its working-set fetch reflex answered `not-owner` even after the #926 (pin
fallback) and #930 (journal-placement fallback) read-side fixes deployed,
because no machine ever PRODUCED the evidence those fallbacks read (coherence
live-proof finding #5, proven on v1.3.372).

The transfer handler now lands the PLACE half: it CASes `place→claim` for the
target as one synchronous pair (the bug-#11 confirmClaim precedent — the
record never rests at `placing`, the shape that queues every later message as
ownership-contention), and each landed CAS journals a topic-placement entry at
its real epoch (§3.3 call-site pairing) so the evidence replicates to the
target machine. A resting `placing` record naming the target is repaired via
claim. An active record held by a non-target machine is never stolen; any
other in-flight shape is left strictly untouched.

## What to Tell Your User

Nothing proactively — this is internal coherence plumbing. If they previously
moved a quiet conversation between machines and the receiving machine couldn't
fetch its files, that path now works: the move itself writes the ownership
record and it travels to the receiving machine automatically.

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- Quiet-topic transfers journal ownership evidence (place + claim halves, real
  epochs, `reason: 'user-move'`) that replicates to the pinned-to machine —
  unblocking its working-set fetch reflex (#930 fallback finally has a producer).
- Half-placed leftovers (resting `placing` records naming the target) are
  repaired on the next transfer of that topic.
- `POST /pool/transfer` response gains `placedOwnership` (whether confirmed
  ownership landed on the target as part of the move).

## Evidence

- `tests/integration/pool-placement-transfer-routes.test.ts` — 6 new boundary
  tests: quiet/never-seen (both halves journaled, record lands `active`),
  self-owned (release + place + confirm, 3 entries), active-other (never
  stolen), active-target (no-op, no epoch bump), resting-placing-target
  (claim repair), placing-other (strictly untouched). 17/17 in file.
- `lint-cas-emit-placement` clean — 8 CAS call sites, all paired.
- Typecheck clean; full suite green on pre-push.
