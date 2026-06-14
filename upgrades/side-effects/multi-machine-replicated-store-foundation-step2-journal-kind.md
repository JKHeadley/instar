# Side-Effects Review — Replicated-store foundation Step 2 (journal-kind tagging + flag-gated emission)

**Version / slug:** `multi-machine-replicated-store-foundation-step2-journal-kind`
**Date:** `2026-06-13`
**Author:** `Echo (instar-dev subagent)`
**Second-pass reviewer:** `not required`

## Summary of the change

Step 2 of the multi-machine replicated-store foundation builds the GENERIC machinery that the concrete replicated stores (preferences, relationships, learnings, …) will layer a journal kind onto — it adds NO concrete store kind itself. New module `src/core/ReplicatedRecordEnvelope.ts` defines (A) the replicated-record envelope type (`recordKey`, `hlc`, `op`, `origin`, `observed`) plus a strict, parameterizable validator that mirrors the CoherenceJournal typed-schema discipline (reject free text, drop+count unknown fields, jail path-shaped fields, validate HLC fields); (B) a `ReplicatedKindRegistry` (ships empty — the registration mechanism, no concrete kind); (C) flag-gated emission (`isStoreEmissionEnabled` — a store emits only when `multiMachine.stateSync.<store>.enabled`, default false); and (D) flag-coherence-gated emission (`shouldEmitToPeer` + `checkPoolFlagCoherence` — never forward a kind to a peer that does not advertise it can receive it, N-peer-correct, one coalesced surface). New module `src/core/stateSyncConfig.ts` resolves + validates the foundation-level `stateSync` knobs (`validateStateSyncInvariants`, the §3.4 maxDriftMs clamp). Config defaults (`ConfigDefaults.ts` `multiMachine.stateSync`), a `StateSyncConfig` type + the `stateSyncReceive` advert flag (`types.ts`), and the server wiring (startup invariant assertion, the empty registry, the advert self-report, the boot-time coherence check) complete it. The change is pure MECHANISM, dark by default; a single-machine install is a strict no-op.

## Decision-point inventory

- `validateReplicatedEnvelope` (RECEIVE door) — **add** — rejects malformed replicated-record data before it can enter a stream. The only "block" surface, and it blocks DATA, never a user action.
- `isStoreEmissionEnabled` / `shouldEmitToPeer` (EMISSION door) — **add** — withholds emitting a store's kind when the store is dark or a peer can't receive it. Withholds JOURNAL TRAFFIC, never a user action.
- `validateStateSyncInvariants` (startup config gate) — **add** — rejects an out-of-range foundation knob at boot (loud, not silent), mirroring `validateSeamlessnessInvariants`.
- `seamlessnessFlags.stateSyncReceive` (capability advert) — **add** — self-reported per-store receive capability in the capacity heartbeat.

---

## 1. Over-block

The validator rejects: a non-object/array; a missing/empty/oversized/path-shaped `recordKey`; a malformed/missing `hlc`; an `op` outside `{put,delete}`; a missing/empty/path-shaped `origin`; a PRESENT-but-malformed `observed`. These are all genuinely-malformed records — there is no legitimate replicated record that fails them. The one deliberate design choice that could look like over-block is the path-shape jail on `recordKey`/`origin`: a store whose primary key legitimately contains a `/` would be rejected. This is intentional (§4 "jail any path-shaped field") — the envelope carries identifiers, not paths, and a concrete store (WS2.1) must choose a non-path key. ABSENT `observed` is explicitly NOT rejected (legal ⇒ "no prior witness" ⇒ flag-on-conflict, the safe direction). No user-message surface exists, so no user input is over-blocked.

---

## 2. Under-block

The validator does NOT semantically validate store-specific fields beyond delegating to the supplied `StoreFieldSchema` — a store that supplies a permissive schema could let through store data the envelope can't reason about. This is by design (parameterizable substrate; the store owns its field discipline) — BUT the envelope's own LOAD-BEARING fields are now protected against a buggy/hostile store by construction (post-adversarial-review hardening, findings #1–#3):
- **A store can NEVER override a reserved envelope field on `data`.** `validateReplicatedEnvelope` strips every `RESERVED_ENVELOPE_FIELDS` key (`op`/`recordKey`/`hlc`/`origin`/`observed`) from the store's returned object (counting each as a dropped field) and spreads the store fields FIRST, the VALIDATED envelope fields LAST — so `data.op/recordKey/hlc/origin/observed` always equal the validated `envelope.*`. The earlier `...storeFields`-last ordering let a store's un-validated, un-jailed copy win on a key collision; that divergence is closed (finding #1).
- **A schema cannot claim a reserved field name.** `ReplicatedKindRegistry.register()` throws (a wiring-time programmer error, like the conflict throws) if `knownFields` intersects `RESERVED_ENVELOPE_FIELDS` — the reserved constant is now ENFORCED, not merely documented for self-check (finding #2).
- **Reusable store-field path-jail.** The §4 path-jail is now reusable machinery for store fields too: a store declares `pathSensitiveFields` (auto-jailed by the validator before its `validate()`, rejecting the whole record with `store-field-path-shaped` + a jail-counter bump) and/or calls the exported `jailStoreStringField(value, ctx)` helper, which feeds the SAME `jailRejects` counter via the new `StoreValidateContext.countJailReject` (finding #3). Structure > Willpower instead of every store re-implementing (and possibly forgetting) the jail.

The emission gate's flag-coherence check trusts the peer's advert: a peer that advertises `stateSyncReceive[store]=true` but is actually unable to apply the kind would still be sent to. This is the same trust model as the existing `ws11DeliverReceive`/`ws12DrainReceive` adverts — the advert is self-reported from machinery presence, and a lying peer is out of scope for this foundation (the applier's per-record validation at the RECEIVE door is the backstop). The validator never throws on bad data (it counts + rejects); a thrown error is reserved for a programmer error (a registration conflict OR a reserved-field knownFields collision), which is the correct loud-fail.

---

## 3. Level-of-abstraction fit

Correct layer. This is a low-level, deterministic PRIMITIVE (a validator + a registry + pure decision functions) with no reasoning and no context — exactly right for a substrate that runs on every replicated record. It does NOT hold smart-gate authority; it produces typed verdicts (`EnvelopeValidationResult`, `shouldEmitToPeer` decision, `PoolFlagCoherenceResult`) that the eventual consumers (the concrete stores, the apply path) act on. It USES the existing lower-level primitive (`HybridLogicalClock.coerceHlc` for HLC validation) rather than re-implementing HLC parsing, and it MIRRORS — does not duplicate — the CoherenceJournal typed-schema discipline (the journal's own `validate()`/jail stays the authority for the existing kinds; this is the parallel discipline for the generic replicated envelope a concrete store will register).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface **over a user action**.

The two refusal surfaces (validator at the RECEIVE door, emission gate at the EMISSION door) are mechanism: they protect DATA integrity and prevent the named silent-drop skew mode. Neither blocks, delays, or rewrites a user-initiated action — there is no user-message path through this code at all. The validator's logic is deterministic-but-NOT-brittle-with-authority-over-a-user: it is a structural schema check (the same class as the existing journal typed-schema validation, which is the accepted pattern), and its "authority" is only over whether a malformed REPLICATED RECORD enters a stream. The emission gate is a conservative "don't forward what the peer can't receive" — withholding traffic, the safe direction. No brittle detector owns block authority over anything a user does.

---

## 5. Interactions

- **Shadowing:** none. The new validator runs on the replicated-record envelope path, which does not yet exist on disk (the registry is empty); no concrete kind is emitted, so it shadows no existing check. The startup `assertStateSyncInvariants` runs alongside `assertSeamlessnessInvariants` (independent config sub-trees) — neither shadows the other.
- **PULL transport + dual-registry coupling (adversarial finding #4).** The real journal-sync transport is RECEIVER-DRIVEN PULL (`PeerPresencePuller.driveJournalDelta` iterates the SENDER's advert from `CoherenceJournal.getOwnAdvert()`, which enumerates the static `JOURNAL_KINDS`; serve + apply both gate on `JOURNAL_KINDS`). There is NO push-forward step, so `shouldEmitToPeer` is intentionally UNWIRED in Step 2 (no concrete kind to serve; it is the pure per-peer decision the WS2.1 serve/pull chokepoint will consult). The named "emit a new kind to an OLD peer → silently dropped" mode manifests on this PULL transport as "an old peer never PULLS a kind absent from its own JOURNAL_KINDS." CRITICAL COUPLING for the consumer PRs: a replicated kind MUST be added to BOTH `ReplicatedKindRegistry` (read by the gate + the `stateSyncReceive` advert) AND the static `JOURNAL_KINDS` (gates serve + apply, enumerated by `getOwnAdvert`) — registering into only the former yields a store that advertises receive=true yet serves/applies/pulls nothing (a silent no-replication). A wiring-integrity ratchet (`tests/unit/ReplicatedRecordEnvelope.test.ts`) asserts every registered replicated kind is present in `JOURNAL_KINDS`. Documented in spec §4 + the `ReplicatedRecordEnvelope.ts` module header.
- **Double-fire:** the boot-time coherence check is guarded (`stateSyncCoherenceSurfaced` one-shot) so a mixed-flag pool surfaces ONCE, not per-tick — explicitly the anti-double-fire design (§4 "surfaces ONCE, coalesced"). With an empty registry it never fires at all.
- **Races:** the registry is constructed once at boot and (in Step 2) never mutated after; the advert self-report reads config + the registry's store list (immutable in this step). No shared mutable state with concurrent code. The validator + decision functions are pure (no shared state).
- **Feedback loops:** none — the coherence check is observe-only (logs a line); it never auto-enables/disables a store or changes the advert.

---

## 6. External surfaces

- **Other agents on the same machine:** none — no new shared files, no new routes.
- **Other users of the install base:** the capacity heartbeat now carries an additional `seamlessnessFlags.stateSyncReceive` field (`{}` until a store is registered+enabled). Older peers that don't know the field ignore it (forward-compat); newer peers read it. Additive, bounded, no breakage.
- **External systems:** none.
- **Persistent state:** config gains a `multiMachine.stateSync` block (foundation knobs only, no `enabled` key) via the existing `applyDefaults`/`migrateConfig` add-missing path — no new on-disk stream, no DB, no ledger. The replicated-record streams themselves land with WS2.1.
- **Timing/runtime:** the boot coherence check timer (60s, unref'd) is inert while the registry is empty.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions — this is internal substrate with no PIN-gated or approval-class route. N/A.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: replicated (journal-kind emission + flag-coherence-gated).** This IS the replication machinery — its entire purpose is to let a store's state follow the agent across machines via flag-gated, flag-coherence-gated journal-kind emission on top of the coherence-journal replication path (the same first-hop replication the existing kinds use). The named replication path is: a concrete store (WS2.1) registers a kind onto `ReplicatedKindRegistry`, the per-record envelope rides the coherence journal's existing serve/apply transport, and emission is gated per-peer on the `seamlessnessFlags.stateSyncReceive` advert so a kind is NEVER forwarded to a peer that would silently drop it (the named data-loss skew mode this step exists to prevent).

- **User-facing notices:** the boot coherence check logs ONE coalesced line to the server log on a mixed-flag pool; it emits no user-facing Telegram notice (a richer surface is the store PR's to add). No one-voice gating needed.
- **Durable state on topic transfer:** Step 2 holds no per-topic durable state (the registry is in-memory, config is per-machine). No strand-on-transfer risk.
- **URLs across machine boundaries:** none generated.
- **Single-machine:** strict no-op — emission is gated on a peer advertising the matching flag, so with no peers nothing is ever emitted; the registry is empty regardless.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert the two new modules + the types/config/server additions and ship as the next patch. No persistent state to undo.
- **Data migration:** none. The `multiMachine.stateSync` config block is add-missing and inert (no per-store `enabled` key shipped); leaving it on an agent after a code revert is harmless (the consuming code is gone). No new on-disk stream is created in this step.
- **Agent state repair:** none — no agent needs notifying or resetting; the advert field simply stops being emitted after a revert (peers tolerate its absence).
- **User visibility:** none — the feature is dark with no user-facing surface; a rollback is invisible to users.

---

## Conclusion

This review produced no design changes — the change is, by construction, pure dark-by-default mechanism with its only two refusal surfaces at the receive door (malformed-data rejection) and the emission door (don't forward to a non-advertising peer), neither of which touches a user action. The N-peer correctness of the flag-coherence check and the coalesced single-surface design were verified by unit tests (3+-peer mixed cases). The line-map golden test was recomputed by hand for the +17 cartographer shift the `stateSync` config block introduced. The change is clear to ship as the substrate WS2.1 will register a concrete kind onto.

---

## Evidence pointers

- `tests/unit/ReplicatedRecordEnvelope.test.ts` (46 tests) — validator both-sides, registry, flag-gated + flag-coherence (incl. 3+-peer mix), config invariants, wiring-integrity advert.
- Gate-parity (run in the worktree): `npx tsc --noEmit` clean; `no-silent-fallbacks` = 471 (= BASELINE, no bump, my files absent from the flagged list); `docs-coverage --check` PASS (class 55%); `feature-delivery-completeness` PASS (no new CLAUDE.md section); `lint-dev-agent-dark-gate` PASS (line-map updated); focused suites `CoherenceJournal*` / `JournalSyncApplier*` / new test all green.
