# Side-Effects Review — Commitments owner-routed mutation (P1.5b)

**Version / slug:** `commitment-mutation-p15b`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (implements §3.4 of the 3-round-converged spec; mutating verb fenced by the durable opKey window + the unchanged CAS state machine; everything dark behind the explicit replication gate)`

## Summary of the change

P1.5b — promises become CLOSE-REQUESTABLE from every machine:

1. `src/core/CommitmentMutation.ts`: verdict-bearing owner-side apply
   (applied | idempotent-noop | invalid-transition | not-found — the
   tracker's null-on-terminal collapsing is disambiguated WITHOUT touching
   the tracker); the durable owner-side OpKeyWindow (the replay control
   beyond the 60s nonce window — records verdicts, survives restarts, TTL
   7d, corrupt → quarantine with worst-case one idempotent re-apply);
   PendingMutationLedger (INTENT-only queue, serialized single-writer
   funnel, per-(origin,id)=4 + per-owner=64 enqueue bounds, TTL with one
   agent-health expiry notice, corrupt-quarantine).
2. `commitment-mutate` verb: union member + its OWN RBAC case (explicitly
   documents verifyEnvelope as the SOLE authority — mesh adds reach, not
   authority) + the owner-side handler (opKey check → apply → record,
   write-ordered).
3. server.ts: forward fn (single attempt, 5s timeout; timeout = AMBIGUOUS
   → queue with the SAME opKey + honest answer; old-peer 403/501 → queue +
   honest answer, never quiet back-off); re-fire on the returning-peer
   seam issues FRESH signed envelopes (the queue is never an
   unauthenticated apply surface); 10-min TTL sweep.
4. routes: deliver / withdraw / resume / beacon-PATCH gain owner-routing
   (own → byte-identical local path; replica → forward with verdict or
   202-queued; bare-id ambiguity → 409 with ?origin retry).
5. Registry: commitment-pending-mutations + commitment-opkeys (72 total).

## Decision-point inventory

- opKey window checked BEFORE apply, recorded AFTER the store write — a
  crash between resolves as idempotent-noop on the re-fire (§4.5).
- Timeout ambiguity: queue with the SAME opKey — if the owner did apply,
  the re-fire returns the recorded verdict; double-transition is
  impossible by construction (proven in integration).
- Local path untouched: a machine whose layer is dark (or single-machine)
  behaves byte-identically; replica-targeted mutations answer an honest
  409 when forwarding is unavailable.

## 1-2. Over/Under-block

Over: enqueue bounds refuse a 5th op on one commitment ('bounded' —
deliberate anti-staging). Under: beacon heartbeats stay owner-side (the
§2 Out deferral, tracked); the merged-view's pendingMutation join uses
the ledger written here.

## 3. Fit / 4. Blast radius

Engine in core (seam-injected); tracker UNTOUCHED (its 77 tests
unchanged); route guards precede byte-identical local paths. Dark
everywhere but explicit replication pairs.

## Evidence

- tests/unit/CommitmentMutation.test.ts — 10 passing (verdict matrix incl.
  stale-observation annotation + patch allowlist; opKey replay + TTL +
  corrupt; ledger dedupe/bounds/TTL-once/pendingKeys/corrupt-notice).
- tests/integration/commitment-mutate-roundtrip.test.ts — 2 passing over
  the REAL signed transport: deliver-from-B transitions A's on-disk store
  (file oracle) + replayed opKey returns the recorded verdict without
  re-applying; THE OFFLINE CASE end-to-end (queue → restart-survival →
  fresh-envelope re-fire → applied → post-apply re-fire idempotent).
- Full sweep: 192 tests across the commitments suites green; wiring +
  parity gates green; typecheck + lint (72 registry categories) clean.
