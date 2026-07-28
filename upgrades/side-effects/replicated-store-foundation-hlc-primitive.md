# Side-Effects Review — Replicated-store foundation Step 1: HybridLogicalClock primitive

**Version / slug:** `replicated-store-foundation-hlc-primitive`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Spec:** `docs/specs/multi-machine-replicated-store-foundation.md` §3 (converged + approved), build-order Step 1
**Second-pass reviewer:** 2 adversarial lenses (distributed-correctness / integration-and-purity) — distributed-correctness CONCUR (brute-forced 3456 merge tuples vs the canonical Kulkarni HLC merge, zero mismatches); integration-purity raised 1 MEDIUM (corrupt persisted stamp crashed construction) — FIXED.

## Summary of the change

The first primitive of the WS2 replicated-store foundation: `src/core/HybridLogicalClock.ts` — a
pure, dependency-injected hybrid logical clock that gives every replicated change a
well-defined cross-machine total order. Operations: `tick()` (local-event advance,
physical never regresses, same-ms bumps logical), `receive(remote, {poolReference})`
(canonical HLC merge across all four physical-comparison branches), `static compare()`
(strict total order: physical → logical → node tie-break). Skew-rejection is
POOL-RELATIVE (reference = max(last.physical, poolReference), not the bare receiver
now()) with a FIXED `maxDriftMs` clamped to [60s, 15min] — honoring the spec's
BLOCKER-5 resolution (a 3-value enum is not a numeric skew source). Restart-monotonic
via injected atomic persistence; a corrupt durable stamp fails toward a fresh-but-
monotonic clock (never crashes construction). Files: `src/core/HybridLogicalClock.ts`
(new), `tests/unit/HybridLogicalClock.test.ts` (new, 44 tests).

This is a PURE LIBRARY with NO wiring yet — its consumers are the subsequent
foundation steps (journal-kind envelope, snapshot-then-tail, quarantine ring,
union-reader), per the spec's own build order §13. It is inert (changes no existing
behavior) until a later step consumes it.

## Decision-point inventory

- No block/allow/gate surface. A clock primitive is mechanism, not authority. The only
  "decision" is `receive()`'s skew-rejection — a typed return value, not a behavior
  gate on anything that exists today (nothing calls it yet).

---

## 1. Over-block
N/A — no gate. `receive()`'s skew-rejection rejects a poison-future remote clock
(physical > pool-relative reference + clamped maxDriftMs); the pool-relative reference
+ [60s,15min] clamp ensure a legitimately-ahead peer or a slow receiver is never
wrongly rejected (proven by tests on both sides of the boundary).

## 2. Under-block
A within-bound skewed clock is accepted (by design — the bound tolerates real drift).
The primitive does not by itself defend against a sustained-malicious clock beyond the
drift bound; that is the quarantine ring's job (a later step). Stated honestly.

## 3. Level-of-abstraction fit
Right layer — a self-contained core primitive with all I/O (clock, nodeId,
persistence) injected, exactly the spec's §3 shape. It layers ON the existing
CoherenceJournal transport without modifying it (this PR touches neither
CoherenceJournal nor JournalSyncApplier).

## 4. Signal vs authority compliance
Pure mechanism. No blocking authority. The skew-rejection is a returned typed result
the (future) caller decides on, not a gate the primitive enforces.

## 5. Interactions
None today — nothing imports it yet. It cannot shadow, double-fire, or race with any
existing code because it is unconsumed. Designed so the later journal-kind step embeds
its serialized form in the replicated-record envelope.

## 6. External surfaces
No route, no config flag, no mesh verb, no CLI. No change visible to other agents,
users, or systems. Net-new module only.

## Framework generality
No framework-launch abstraction touched (does not modify `frameworkSessionLaunch.ts`).
A clock primitive is framework-agnostic. N/A beyond that.

## 7. Multi-machine posture (Cross-Machine Coherence)
**machine-local BY DESIGN (this slice)** — each machine runs its own HLC; the clock is
not itself replicated. Its PURPOSE is to become the cross-machine ordering substrate:
later steps stamp replicated journal records with this HLC so the union-reader can
order changes from all machines deterministically. Phase-C clean: the node-id space is
unbounded (any string), skew handling is pool-relative (no 2-peer / no-LAN assumption),
and there are no per-pool-size structures in the primitive.

## 8. Rollback cost
Trivial: a new unconsumed file. Reverting deletes `HybridLogicalClock.ts` + its test;
nothing depends on it, no durable state, no migration.

---

## Second-pass review (2 adversarial lenses)

- **distributed-correctness:** CONCUR. Brute-forced 3456 (lastP,lastL,remP,remL,now)
  tuples against the canonical Kulkarni et al. HLC merge — zero mismatches; no
  off-by-one in any of the four branches; `compare()` verified a strict total order
  with deterministic node tie-break. Skew-rejection sound + pool-relative.
- **integration-and-purity:** 1 MEDIUM — a non-null malformed persisted stamp threw
  out of the constructor instead of degrading. FIXED: `coerceHlc(loaded)` is wrapped;
  a corrupt durable stamp logs `hlc-load-corrupt` once and degrades to the same
  fresh-clock path as the missing-file case, then ticks monotonically. Proven by an
  8-corrupt-shape table-driven test. Purity confirmed: clock/nodeId/persistence all
  injected; no ambient Date.now()/fs in the hot path.

Verdict: correct + pure + bounded; ship.
