# Side-effects review — Chief of Staff PR 1: `chief-of-staff-record` journal kind + ChiefOfStaffStore (dark)

**Spec:** docs/specs/chief-of-staff-topic.md (converged 6 rounds, codex gpt-6-astra external; approved by Justin 2026-11-09 12:09 PT, topic 141014).
**Tier:** 2 (driven by a Tier-2 spec; this PR itself is small and fully reversible).
**Change size:** 1 new module (`src/core/ChiefOfStaffStore.ts`, ~480 LOC), journal kind registration in `src/core/CoherenceJournal.ts` (8 per-kind map entries + `emitReplicatedRecordWithSeq` + `awaitDurableSeq`, ~60 LOC), 3 one-line wiring entries (`ReplicatedStoreReconcilerWiring.ts`, `JournalSyncApplier.ts`, `commands/server.ts`), 4 new test files + 1 ratchet-list update.
**Effort:** spec review 6 rounds (the spec, not this PR); build attempts: 1 (two unit-test fixes on first run: `lost` reachable only via `rejected`; unpark time read from the event's `at`, not the HLC).

## Summary

Adds the replicated-store kind the Chief of Staff will write to, with every record kind as an immutable event and every mutable view (open/closed, intent state, restart brakes, lease expiry) derived by a pure fold over the union. Adds the one journal capability the §2.4 action protocol needs and that did not exist: a way to learn a record's seq and wait until it is fsynced. **Nothing emits.** No flag is injected, no route is added, no runtime behaviour changes for any agent. The wiring test asserts darkness by scanning `src/` for any emit call site.

## 1. Over-block
No decision point is added; nothing is rejected at runtime. The schema rejects malformed records (unknown recordType, non-`platform:id` conversation key, path-shaped machine ids, cadence < 1h, empty done definition, non-owner `confirmedBy`, unknown transition/writer). A legitimate record that fails here would be a builder bug surfaced loudly as `schema-rejected`, never a silent drop. No issue identified.

## 2. Under-block
The folds accept any signature-valid renewal and any owner-tap lifecycle event; validating the signature and the tap principal is the caller's job in PR 2/3 (`verifySignature` is injected; `by: 'owner-tap'` is written by the tap route). This PR cannot be gamed because nothing writes to it. The gap to carry forward: PR 2 must bind `verifySignature` to the mesh machine-key verifier, not a stub.

## 3. Level-of-abstraction fit
Right layer: it rides the generic replicated-record substrate (`ReplicatedRecordEmitter` + `CoherenceJournal` + `ReplicatedKindRegistry`) exactly like `TopicPinReplicatedStore`, adding no parallel mechanism. `awaitDurableSeq` lives on `CoherenceJournal` because that is the only place `highWaterSeq` is known; it is generic (any kind), not CoS-specific.

## 4. Signal vs authority compliance
No blocking authority is added. The folds are deterministic derivations of recorded facts; the LLM judge (PR 3) will be a signal into them, never the other way round. `LEGAL_TRANSITIONS` and the writer-role rule are hard-invariant validation on a closed enumerable domain (the principle's own carve-out), not judgment blocks.

## 5. Interactions
- Adds one `JournalKind`; every `Record<JournalKind, …>` map is updated (the compiler enforces it) and the three ratchet tests that enumerate kinds/stores pass.
- `emitReplicatedRecordWithSeq` wraps the existing `emitReplicatedRecord` unchanged; `awaitDurableSeq` only calls the public `flush()` and reads `highWaterSeq`/`flushErrors`. It cannot double-fire or shadow anything.
- Reconciler: the store is allow-listed (single server-constructed writer); no seam added, so `seamedStores.length` is unchanged.
- No interaction with the Liveness Reconciler, resume queue or autonomous path yet (PR 2).

## 6. External surfaces
None. No route, no notice, no CLI, no app field. The journal stream file for the kind is created lazily on first emit, which never happens in this PR.

## 6b. Operator-surface quality
Not applicable: no dashboard/app/console change in this PR.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Unified.** The kind is a replicated-record kind (one durable local stream per machine, pulled by peers through the existing journal-sync transport); emission will be gated by `multiMachine.stateSync.chiefOfStaff`, read by the generic `resolveStateSyncStores` resolver (no code needed). Records are immutable and event-keyed, so the substrate's whole-record HLC merge is sufficient and arrival order cannot change a derived view: the e2e test emits on A, applies on B through `JournalSyncApplier`, folds both sides identically, then performs a concurrent write on each machine (A closes, B edits the binding) and proves the closure is invalid on BOTH sides. Retention is never-delete (`rotateKeep: 0`) because a dropped archive would erase bindings and the breaker window; growth is tiny; compaction is tracked as CMT-1415. No machine-local surface.

## 8. Rollback cost
Pure addition behind an unregistered-until-boot kind. Revert = remove the module and the kind; a journal stream for an unused kind is inert and ignored by readers (unknown kinds drop forward-compat in the applier). No migration, no data repair, no agent-state change.

## Found problems (triage)
- `InitiativeTracker` treats an unparseable `lastTouchedAt` as healthy → queued in the feedback queue (`fb-a80a67d5-94a`, filed during spec review).
- Journal per-key compaction for never-delete kinds → tracked commitment CMT-1415.

## Proportion
Tier 2 spec, small PR (≈600 LOC incl. tests), 1 build attempt. In line.

## Second-pass review (Phase 5)

**Concur with the review.** Independent reviewer (Explore subagent, 2026-11-09 12:29 PT) verified: the dark claim holds (registration only; no emit call site in `src/`); `awaitDurableSeq` resolves only on the fsync-advanced `highWaterSeq` and fails closed on invalid seq, inactive journal, flush-error growth and deadline; the folds match §1.2/§2.7 (closure valid only on an exact `bindingHlc` match, `reopened`/`unpark` owner-tap only, `lost` only from `rejected` by the holder, breaker window ignores attempts older than the last unpark and is not cleared by progress, `nextActionAllowedAt` independent of `nextCheckAt`); the multi-machine answer is honest for whole-record HLC merge with never-delete retention; no blocking authority added.

Minor notes carried forward to PR 2 (none blocks this PR):
- `awaitDurableSeq` does not check the journal incarnation; a close+reopen inside one 25 ms poll would reload `highWaterSeq` from disk. Negligible here; PR 2 may pass the incarnation through if the protocol ever needs it.
- `writer` and `by` are self-declared by the record. They are meaningful only once PR 2's routes write them honestly (the ownership machine writes execution transitions; owner-tap routes write `by: 'owner-tap'`), alongside binding `verifySignature` to the mesh machine-key verifier.
- Time comparisons in the folds are ISO-string comparisons; every writer must use `toISOString()` (UTC `Z`). PR 2 normalises at the write path.
