# Side-Effects Review — Team access for one-machine agents (step 2a)

**Version / slug:** `team-2a`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `required before the PR opens`

## Summary of the change

Builds step 2a of docs/specs/team-roles-and-access.md §4.1 in pieces. This first piece adds the role map, the event validators and the signed access log with the confined list. Nothing calls it yet, so no behaviour changes.

## Decision-point inventory

`mayDoAsTeam`, the fold's standing check, and the confined list: invariant, per the spec's decision table.

## 1. Over-block

None in this piece: nothing is wired.

## 2. Under-block

None in this piece.

## 3. Level-of-abstraction fit

A pure role map in `src/permissions`, the store in `src/core`, beside the other signed stores.

## 4. Signal vs authority compliance

Authorization is deterministic by design, per the spec. No brittle check holds judgment authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariants, classified in the spec.

## 5. Interactions

None yet.

## 6. External surfaces

None yet.

## 6b. Operator-surface quality

None yet.

## 7. Multi-machine posture (Cross-Machine Coherence)

2a is one machine by decision (spec §4.1). The row format is built for 2b's replication.

## 8. Rollback cost

A plain revert: nothing reads these files yet.

## Class-Closure Declaration (display-only mirror)

No self-triggered action in this piece.

## Second-pass review

Pending, before the PR opens.

## Conclusion

Foundation only.
