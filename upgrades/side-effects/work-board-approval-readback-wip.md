# Side-Effects Review — Work Board approval journal readback checkpoint

**Version / slug:** work-board-approval-readback-wip
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** independent journal readback reviewer

## Summary of the change

Tier 2 project checkpoint. Adds exact-event journal readback for the owner Work Board approval writer, including tests with the real Work Board journal. This component reports a winner, proved absence or unresolved evidence. Production enrollment and routes are outside this checkpoint.

## Decision-point inventory

- Journal receipt evidence — add exact event lookup against the durable watermark and current incarnation.
- Proof of absence — add a contiguous current-epoch sequence and a reservation check.

## 1. Over-block

An archive set exceeding the complete-reader bound cannot support proof of absence. Even a matching event is unresolved when the same scan cannot rule out a conflicting event. The production adapter can use a verified complete index to improve availability.

## 2. Under-block

The caller supplies the trusted enrollment baseline, exact decoder and reservation evidence. A production port must verify all three and enforce writer proof at append and projection. This file alone cannot activate a writer or authorize an approval.

## 3. Level-of-abstraction fit

This is a proof reader for the enrolled Work Board writer. It reuses the CoherenceJournal durability contract and does not change the journal or replicate its stored data.

## 4. Signal vs authority compliance

[Signal vs Authority](../../docs/signal-vs-authority.md). The reader uses exact identity, sequence and committed contents. No advisory signal can provide an affirmative receipt or absence.

## 4b. Judgment-point check

No static heuristic decides a competing-signals judgment. Incomplete sequence or unavailable writer proof is unresolved evidence.

## 5. Interactions

- **Shadowing:** there is no production route change in this checkpoint.
- **Double-fire:** conflicting exact IDs and unresolved reservations prevent proof of absence or a winner.
- **Races:** recheck the watermark, incarnation and writer proof after the scan.
- **Feedback loops:** the reader emits no journal record and drives no pickup.

## 6. External surfaces

No production configuration, route, migration or client behavior changes.

## Verification

The focused suite includes exact winner, provisional write, incomplete and noncontiguous scans, reservations, conflicts and writer loss. The real journal integration test observes one Work Board append before and after its actual durable watermark.

## Independent second pass

The reviewer concurred after validating every covered row against the existing Work Board envelope and matching writer origin. Malformed or foreign rows now leave absence unproved. The fixture decoder confirms journal durability and uses a known event. A production decoder must reconstruct the exact binding from durable record fields.
