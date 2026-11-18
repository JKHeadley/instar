# Side-Effects Review — The owner record: a signed chain every machine computes the same way

**Version / slug:** `identity-security-piece2a-owner-record-chain`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec: `docs/specs/identity-security-piece2a-owner-record-chain.md`, which converged after an initial round and three deltas.

- **`src/core/ownerRecord.ts`** is a pure library: `evaluateOwnerRecord(entries, opts)` and `signOwnerRecordEntry(draft, sign)`.
  - **Entries:** signed canonical JSON with a namespaced signer. Only a merge may have several parents.
  - **Authority:** the parent specs' powers. Owner keys sign everything. A machine key signs its own TLS key, and policy and merges only at Basic. The first owner key is self-signed and passes the caller's proof check.
  - **Structure versus effect:**
    - hard failures (unauthorized, or no verifying signature) leave the structure;
    - soft failures (the global rules, or apply conflicts) stay for connectivity, but don't count and are never tips.
  - **Global rules, judged once against pass A:** machine keys stop when the owner starts, and a revoked key instance's later entries count for nothing. Pass-A revocations are never undone.
  - **Forks:** additions are held until a merge. Revocations and TLS keys are side entries, so they never fork the record.
  - **Status:** `ok`, `record-invalid`, `no-valid-key`, `owner-lost` or `input-too-large`, plus the `effective` set for 2b's storage.
- **No callers.** Nothing in the agent changes until piece 2b stores and replicates the record.

## Decision-point inventory

- **None live.** The library decides nothing until 2b calls it.

---

## 1. Over-block

None. There are no callers.

## 2. Under-block

None live. The requirements 2b must meet are stated in spec §4: store only effective entries and their ancestors, cap entries per signer per day, and keep the last good state on an over-bound input.

## 3. Level-of-abstraction fit

One pure module, taking injected options (the pinned genesis and the first-owner proof check). It reuses `canonicalJson` and Node's Ed25519.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface for callers (a library with no callers; when 2b uses it, it is a deterministic evaluator over an enumerable domain: signatures, key ids, entry kinds).
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

- **8 KB per entry,** and **2,000 raw entries** per evaluation.
- **No cap on authentic entries,** so a revocation is never refused.

## 5. Interactions

None. The library has no callers.

## 6. Rollback

Revert. Nothing depends on it.

## 7. Evidence

Unit: `tests/unit/identity-piece2a-owner-record.test.ts`, 30 tests with real Ed25519 keys. They cover:
- every-order equivalence;
- the authority table both ways;
- forks and merges;
- mutual revocation and `owner-lost`;
- every reviewer probe scenario (A to J) as a regression test;
- the storage round trip: a copy holding only `keep` and its ancestors evaluates to the same state;
- hostile input (objects with a bad `toString`) rejected, never a crash.

## Second-pass review

An independent reviewer subagent read the code against the spec and probed it. Round 1 found 3 defects:
- a crash on hostile input;
- a stored copy that could revive a revoked key's entry;
- an order-dependent `rejected` list.

All three are fixed, each with a regression test. Round 2 concurred after fuzzing 10,000 random graphs, which found no full-versus-stored difference. Speed: a 2,000-entry chain takes 0.54 s; a 2,000-entry fork takes 0.23 s. Round 3 reviewed a follow-up from the 2b design review: nothing may build on a TLS entry, and only each machine's winning TLS entry is kept. It concurred after fuzzing 11,500 graphs with TLS entries mixed in. Review: `.instar/state/identity-build-144636/reviews/p2a-second-pass.md` in the agent home. For 2b, the reviewer noted that spam can grow `keep` only while the record is already `contested` or `owner-lost`. 2b handles that state by holding, with a visible forced reset.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** a pure library with no callers and no self-triggered action.
