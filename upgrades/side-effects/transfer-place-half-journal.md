# Side-Effects Review — Transfer PLACE-half journaling (coherence finding #5)

**Version / slug:** `transfer-place-half-journal`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`POST /pool/transfer` now lands the PLACE half of a deliberate move: for a quiet
topic (never-seen or released ownership record) it CASes `place→claim` for the
target as one synchronous pair and journals the placement (`reason: 'user-move'`,
real epoch) so the entry replicates to the pinned-to machine — closing the
"no machine ever produced the evidence the #926/#930 read-side fallbacks read"
gap proven live (the working-set reflex answered `not-owner` after a transfer
even on v1.3.371+). A resting `placing` record naming the target is repaired via
claim (the bug-#11 shape). Response gains `placedOwnership`.

## Decision-point inventory

One: which ownership-record shapes the block may mutate. Active-with-target →
skip (no-op). Never-seen/released → place+claim. Resting placing-with-target →
claim repair. Everything else (active other-machine, placing other-machine,
transferring) → strictly untouched.

## 1. Over-block

Nothing new is rejected; the route's accept/reject surface is unchanged. The
block only ever ADDS ownership evidence; on any CAS refusal the transfer still
succeeds exactly as before (`placedOwnership:false`).

## 2. Under-block

A topic actively owned by a third machine still journals nothing on transfer
(deliberate — never steal a live session; the pin drives re-placement on real
traffic, which CASes and journals through the existing router chokepoint). A
`placing` record naming a different machine is also left alone — repairing
someone else's in-flight placement is not this handler's call.

## 3. Level-of-abstraction fit

Right layer: the same handler that already owns the RELEASE half (and its
journaling) now owns the PLACE half — the two halves of one move live at one
chokepoint. The state machine itself is untouched; the handler composes the
existing legal transitions (place, claim) exactly as the router's confirmClaim
precedent does.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. Both CAS failures and journal failures are
best-effort (`@silent-fallback-ok` / observability-never-endangers-the-observed):
the transfer response never fails because of this block, and the journal entry
is evidence, not actuation.

## 5. Interactions

- **SessionRouter**: claim immediately follows place so the record never RESTS at
  `placing` — the shape that queues every later message as ownership-contention
  (bug #11). A real message for the topic now finds `active(target)` and forwards.
- **Working-set reflex (#926/#930)**: the journaled entry replicates and the
  target's wsOwnerOf journal-placement fallback finally has something to read.
- **Post-transfer closeout**: unchanged — it keys on ownership moving away, which
  this block makes MORE accurate (the registry now reflects the deliberate move).
- **Ownership nonces**: fresh `tplace`/`tclaim` nonces per call; no replay overlap
  with router (`:c:`/`:cl:`) or release (`:rel:`) nonce families.

## 6. External surfaces

One additive JSON response field (`placedOwnership`). No new routes, no config,
no notifications, no Telegram. Journal entries use the existing topic-placement
kind/op-key contract (`${topic}:${epoch}` — real epochs, so no dedupe collision
with router-emitted entries).
