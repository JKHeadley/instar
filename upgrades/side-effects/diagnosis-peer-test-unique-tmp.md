# Side-Effects Review — Diagnosis peer test unique temp path

**Version / slug:** diagnosis-peer-test-unique-tmp
**Date:** 2026-11-06
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change
Tier 1, one test file, 2 lines. A fixed attempt id becomes a random one per run. No runtime change.

## Decision-point inventory
No decision point touched.

## 1. Over-block
No block/allow surface.

## 2. Under-block
No block/allow surface. A run that crashes can still leave a uniquely named folder in `/tmp`, which no longer affects other runs.

## 3. Level-of-abstraction fit
The collision came from the test's fixed id, so the test is the right place.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. Not applicable; test only.

## 4b. Judgment-point check
None.

## 5. Interactions
The '2'.repeat(32) id elsewhere in the file creates no temp folder and is unchanged.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable; test only.

## 8. Rollback cost
Plain revert.
