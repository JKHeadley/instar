# Side-Effects Review — reflex journal-placement fallback (#930)

**Version / slug:** `reflex-placement-fallback`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (third live-proof finding; ~20-line fallback with a wiring-shape regression test; admits only a read-only/jailed/verified pull)`

## Summary of the change

#927's quiet-topic pin fallback (#926) is router-local-blind: the pin
written by a transfer lives on the LEASE HOLDER, so the pinned-TO machine
still answered not-owner (live, v1.3.369). Second fallback in wsOwnerOf:
the newest topic-placement JOURNAL entry (own + replica) — `owner ===
self` ⇒ self-owned at that entry's epoch. The placement entry is emitted
at the router's CAS chokepoint (the strongest placement evidence
reachable from the target machine).

## Signal-vs-Authority justification (the load-bearing call)

The journal-actuation ban guards kill/spawn/move decisions. What this
fallback admits is a working-set PULL: read-only on the source,
hash-verified, jailed, never-clobber on the destination, idempotent, and
still guarded by the per-write stillCurrent recheck (any REAL claim
supersedes the in-flight pull). Nomination has run on replica evidence
since P2 §3.3 by design — this extends the same trust class to the
ownership precondition for the same operation, nothing else. The
coordinator module is deliberately NOT in the actuation-ban set (it
already imports the reader for nomination).

## 1-2. Over/Under-block

Over: none new — the fallback only ever yields SELF. Under: a topic
whose placement was never journaled (pre-P1 history) still answers
not-owner honestly.

## 3. Fit / 4. Blast radius

~20 lines in the existing wsOwnerOf seam (the spec-named home), spec
§3.3 delta + eli16 amendment ride along. Active only where replication
is explicitly enabled. Worst case = an unnecessary pull that verifies
and lands nothing new.

## Evidence

- tests/unit/working-set-ownerof-wiring.test.ts — wiring-shape assertion
  for BOTH fallback steps + the honest default.
- Typecheck clean. The live proof completes on the echo pair after this
  ships (the staged 77901 artifact + recorded hashes).

## Addendum — the dropped commitments advert (same branch)

While verifying P1.5a live, found that fetchPeerCapacity's narrowing
return discarded the peer's commitmentsAdvert — driveCommitmentsSync
never fired; zero commitment replicas ever landed in either direction.
Pass-through (one spread line) + a source-shape regression test. The
integration suite drove the engine directly and missed this seam — the
wiring-integrity gap class.
