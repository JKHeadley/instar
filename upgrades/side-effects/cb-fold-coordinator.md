# Side-effects review — FoldCoordinator, fold record and boot sweep

**Version / slug:** `cb-fold-coordinator`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.3 ("The fold transaction": the durable fold record, one writer, compare-and-swap on `(foldId, step, generation)`, owner-only, carriers keyed by `foldId` with record-driven lifetimes, `recoverPendingFolds` before the inbound sweep, Quarantine handover to the sentinel, the consecutive-rollback breaker), §9.7/§14 (fold records never backed up), §16 Phase 0 ("the `FoldCoordinator` with its fold record and boot sweep"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0, slice 7b; stacked on slice 7a (keyed fenced lease) and slices 2–6.
**Tier:** 2 (lifecycle state machine with a boot-time sweep that deletes carriers; no fold can begin in production yet). Size: 12 files, ~1,450 LOC incl. ~660 test LOC. Effort: built across two sessions (one context-limit restart); one in-build gap found and fixed (ownership after a crash that killed the session), backup exclusion added on re-reading §14; one review round so far.

## Summary of the change

1. **`src/monitoring/FoldCoordinator.ts`** — the single writer of a topic's fold record.
   - `FoldRecordStore`: one 0600 JSON file per fold under `state/context-layers/<topic>/fold-records/` (dirs 0700), state and pointers only; lists in a `.sidecar.json` beside it. Unsafe topic or fold ids throw before any path is built.
   - The state graph of §9.3 (`prepared`, `shadow-probing`, `locked`, `snapshotted`, `staged`, `replacing`, `probing`, `committed`, `rolled-back`, `quarantined`, `aborted`); any other edge is refused (no skipping to commit, no abort past the point of no return, terminal is terminal).
   - `begin(topic)`: §9.3 step-1 preconditions in order, each a named `fold-skipped` reason (`not-owner`, `owner-unknown`, `shadow-mode`, `fold-in-progress`, `no-row-source`, `no-sentinel`, `peer-unknown`, `not-exclusive`, `no-hold-queue`, `layers-not-replicated`, `rows-missing`, `lock-held`), then takes the keyed fold lock (slice 7a) and writes the record at the lock's generation and the ownership epoch.
   - `transition(...)`: CAS on `(state, seq, generation)`; refused on a missing record, a mismatch, a disallowed edge, a non-owner, a changed ownership epoch, or a lost lock (fencing pins the exact signed lock record); `replacing` is refused while another fold on this machine is past the point of no return (`machine-busy`, never queued). A terminal transition releases every registered carrier, drops the sidecar, releases the lock and updates the breaker.
   - `quarantine(...)`: only past the point of no return; hands the lock to the sentinel role at a new generation (a handover, never a re-acquire); containment stays.
   - `recoverPendingFolds()`: for every non-terminal record this machine wrote and owns: at or before `staged` (and `shadow-probing`) ⇒ `aborted` synchronously with carriers and lock released; `replacing`/`probing` ⇒ `quarantined` for the sentinel (if the handover fails the record is still marked `quarantined`, keeping containment); then every carrier whose `foldId` has no record (or a terminal one) is released and reported as an orphan. A record another machine wrote, or one on a topic this machine does not own, is observed only.
   - Breaker: K = 3 consecutive rollbacks (judge preemption excluded) put the topic in shadow mode until `rearm`.
2. **`src/monitoring/foldCarriers.ts`** — today's carriers adapted to the coordinator: the clear-seed pointer (slice 3), fold-sourced keep-instructions (slice 5; the standing packet's own text is never a fold carrier), and `PendingInjectStore` records tagged with `fold`.
3. **`src/monitoring/foldCoordinatorBoot.ts` + `src/commands/server.ts`** — built at boot and `recoverPendingFolds()` run unconditionally, synchronously, **before** the Durable Inbound Message Queue sweep and `recoverPendingInjects` (§9.3 boot order). Orphans and quarantines are reported through `DegradationReporter`. Ownership: single machine or dark pool ⇒ the host is the owner (and stays the sweep owner for its own record after a crash killed the session); live pool placement ⇒ `owner-unknown`, never act, until ownership records are consulted.
4. **`src/core/foldLeaseFactory.ts`** — `createFoldLeaseLockForAgent`: signs with the machine identity when the machine has one, else with a per-agent local Ed25519 fold key (0600) that only verifies its own locks.
5. **`src/core/PendingInjectStore.ts`** — records may carry `fold: { foldId, topicKey }`; the generic boot sweep skips them (never redelivered, never expired); the fold settles them.
6. **`src/monitoring/clearSeedPointer.ts`** — the pointer may carry `topicKey` (validated) so the sweep can match it to its record; `listClearSeedPointers` for the carrier.
7. **`src/core/keyMaterialPaths.ts`** — `state/fold-leases/` added (never served, never editable, never backed up).
8. **`src/core/BackupManager.ts`** — `fold-records` and `fold-leases` added to `NEVER_BACKUP_PATH_SEGMENTS` (§9.7/§14: a fold record restored from backup could resurrect a finished fold's containment; the fold-leases directory holds the local signing key).

**Phase 0 posture:** no fold can begin in production. `sentinelHeartbeatFresh` and `layerKindPresent` are false until slices 9 and 10 supply them, and `topicRowsPresent` is false until the Phase 1 row carrier. The boot sweep runs on every boot and on a healthy agent finds nothing.

## Decision-point inventory

- **Added:** whether a fold may begin (preconditions, all fail-closed toward not folding); whether a fold record may move (CAS + fence + owner); what the boot sweep does with a crashed fold (deterministic by state). No LLM judgment, no message gating.

## 1. Over-block

- On a live pool every fold is skipped as `owner-unknown` until ownership records are wired. That is the spec's rule (§9.3) and the intended Phase 0 posture.
- A coordinator refuses a transition when the ownership epoch changed, even if the same machine regains ownership. Correct: a new epoch is a new owner.
- `machine-busy`: a second fold reaching `replacing` on the same machine is declined, not queued (§9.3).

## 2. Under-block

- A torn or unparseable record file is skipped by the store listing, so its carriers are then released as orphans rather than the record being treated as `quarantined` (§14 table: "missing or torn ⇒ treated as quarantined ⇒ rollback"). In Phase 0 no record past the point of no return can exist; the sentinel slice adds torn-record quarantine with its rollback. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel reconciles torn fold records as quarantined) -->
- A record restored from backup in a non-terminal state is swept like a crashed one (abort before PNR, quarantine after) rather than always `aborted`; with fold records now excluded from backup and restore, such a record cannot arrive through instar's backup path.
- The fold hold, the per-session markers and the engine checkpoint are not carriers yet: they are built in slices 8 and 9, which register their own carriers. <!-- tracked: CMT-1536 (Phase 0 tasks 8 and 9 register their carriers with the FoldCoordinator) -->
- The orphan pass releases a machine-local carrier with no record even when this machine does not own the topic; every carrier today is a file on this machine that nothing else can settle.

## 3. Level-of-abstraction fit

Right layer: one coordinator per machine, mirroring `CommitmentTracker.mutate`'s single-writer CAS shape as the spec asks; it uses slice 7a's lock rather than a new primitive, and leaves step execution (staging, replacing, probing) to the step runner (Phase 2) and rollback to the sentinel (slice 10).

## 4. Signal vs authority compliance

The coordinator holds authority over its own records and carriers only. Every precondition is deterministic and fails closed toward *not folding* (today's behaviour). It never blocks, filters or rewrites a message; the generic inject sweep's skip covers only records the fold itself tagged.

## 5. Interactions

- **Inbound queue and inject sweeps:** runs before both. Fold-tagged inject records are skipped by `sweepPendingInjects` (test) AND by the inbound boot sweep's PIS matcher in server.ts (`hasPisRecord`/`clearPisRecord` filter out `fold`), so a fold's inject is never counted, cleared or redelivered by either. Non-fold records are untouched.
- **CompactionSentinel fallback (slice 6):** its staged fallback is a `doNotReplay` `compactionFallback` record without `fold`; the fold carrier never lists it (it filters on `fold`).
- **Clear seed (slice 3) / keep-instructions (slice 5):** only pointers carrying a fold source/topic are carriers; the standing packet's keep text is not (test).
- **Backup:** fold records and the fold lock are never snapshotted or restored (test with a positive control).
- **File viewer:** `state/context-layers/` is already never-served (slice 4); `state/fold-leases/` (the local fold signing key, lock and floor files) is now in the code-owned `KEY_MATERIAL_PATHS`, so it is never served, never editable and never backed up.

## 6. External surfaces

None visible to users or other agents. Boot logs a line only when the sweep acted; orphans and quarantines are DegradationReporter rows.

## 7. Multi-machine posture

Machine-local by design in Phase 0: the record is written and acted on only by the topic's owner, which on a single machine or dark pool is the host. On a live pool the coordinator does nothing (`owner-unknown`). Replication of fold records as a journal kind and the git-medium lock arrive with the layer kind (slice 9) and the pool binding, per §14. <!-- tracked: CMT-1536 (fold record replication with the layer kind; git-medium lock binding when pool placement is live) --> A fold never strands on topic transfer because none can begin while placement is live.

## 8. Rollback cost

Revert. State written in production today: at most the local fold key file under `state/fold-leases/` (created when the coordinator is built). No migration.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: the boot sweep runs once per boot, synchronously, over a finite set of files; `begin`/`transition` are called by their owner per fold step. No timer, loop or retry.

## Evidence

- `tests/unit/FoldCoordinator.test.ts` (30): state graph edges; begin preconditions in order, each skip named; record files 0600; CAS mismatch, stale generation, lost lock, epoch change and non-owner refused; terminal transition releases carriers and lock; `machine-busy`; quarantine handover fences the coordinator; boot sweep at every step; sweep owner after the session died (abort, and — added this round — a quarantined fold can still be rolled back; positive control: without the fix the test fails `not-owner`); a record another machine wrote is never moved; live pool only observes; orphans released loudly; breaker trips at 3, judge preemption excluded, re-arm.
- `tests/integration/fold-coordinator-boot-wiring.test.ts` (9): `buildFoldCoordinator` with the real local fold key, real store and real carriers across a simulated restart: abort at `staged` frees all three carriers and the lock; quarantine at `replacing` keeps them and is idempotent across a second boot; host resolves its fold after its session died; orphans released with events; standing keep text untouched; the generic inject sweep never redelivers or expires a fold record; Phase 0 posture (`no-sentinel`) and live pool (`owner-unknown`).
- `tests/e2e/fold-coordinator-crash-lifecycle.test.ts` (4): a REAL child process (production modules via vite-node) begins a fold, stages real carriers and exits mid-fold at `locked`, `staged` and `replacing`; this process then boots like the server and sweeps: aborted with carriers and lock freed, or quarantined with containment intact. Plus a wired-source check that server.ts builds the coordinator and sweeps unconditionally before the inbound sweep and `recoverPendingInjects`.
- `tests/unit/BackupManager-never-backup.test.ts` (+1): a snapshot including `state/` carries no fold record or fold lock file (positive control: fails with the segments removed).
- `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10):** "Concern raised." BLOCKING: (1) a COMMIT was accepted on an expired-but-unsuperseded lock (`allowExpired` covered every terminal state), contradicting §9.3 Quarantine ("nothing is committed"). MINOR: (2) a failed quarantine handover leaves a record nothing can move; (3) a holder-id change (unpaired → paired) strands this machine's own records, and two unpaired machines share the literal holder id; (4) nothing discards staged writes or deletes the packet; (5) a crash between the terminal write and the end of settle leaks the lock (and `begin` leaks it if the record write throws); (6) the boot wiring read a boot-time config snapshot and omitted the inbound pool gate; (7) artifact §5 overstated inject isolation (the inbound boot sweep's PIS matcher had no fold filter); (8) the new private key was outside the code-owned key list; (9) carrier discoverability depends on optional fields, and keepInstructions documented the wrong source form; (10) test gaps (commit-on-expired, handover-failed, torn record, compactionFallback survival; source-order wiring check).

**Resolution:**
1. Fixed: only `rolled-back`/`aborted` may run on an expired lock; commit is refused `lock-lost`. Test added; positive control: with the old rule the test fails.
2. Tracked for the sentinel slice (it owns quarantine reconciliation and re-handover): a test now pins the branch (record `quarantined`, role still `coordinator`, containment kept). <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel retries the quarantine handover / reconciles a coordinator-role quarantined record) -->
3. Tracked with the pool binding: unpaired single machines are the only users of the local key today; a pairing migration must adopt or abort records signed by `local-fold-key`. <!-- tracked: CMT-1536 (fold records written under local-fold-key adopted or aborted at first pairing) -->
4. Packet: fixed — the clear-seed carrier now deletes the staged packet it points at (only if it resolves inside the layers root); integration test asserts the packet is gone on discard and kept on quarantine. Staged store writes: no writer exists until the layer kind (task 9), which discards them through the sidecar list it fills. <!-- tracked: CMT-1536 (Phase 0 task 9: layer kind discards sidecar-staged writes on abort/rollback) -->
5. Fixed: `settle` drops the sidecar LAST as its completion marker; the boot sweep re-settles any terminal record whose sidecar remains (lock and carriers freed). The breaker is never counted on a re-settle, so a crash between the `rolled-back` write and the breaker update leaves that one rollback uncounted: it fails toward more folding, never toward over-tripping. `begin` releases the lock if the record write throws. Unit test: crash between terminal write and settle ⇒ `lock-held` before the sweep, free after, idempotent.
6. Fixed: owner and queue inputs read `liveConfig` on every call, and `inboundQueueLive` applies the same three gates as the inbound boot sweep (enabled, not dry-run, `inboundQueuePoolGateOpen`).
7. Fixed in code (fold filter on the PIS matcher) and in §5 above.
8. Fixed: `state/fold-leases/` added to `KEY_MATERIAL_PATHS` (key-material unit, walk integration and never-serve e2e tests pass).
9. Doc fixed (`fold:<topicKey>:<foldId>`). The optional `topicKey` on a clear-seed pointer stays optional for slice 3's non-fold writer; the fold path always sets it (the coordinator's runner, Phase 2). <!-- tracked: CMT-1536 (Phase 2 runner writes fold pointers with topicKey; verification suite asserts it) -->
10. Added: commit-on-expired (unit), handover-failed, torn record and compactionFallback survival (integration). The source-order wiring check stays alongside the real-process crash e2e; a booted-server check belongs to the adapter verification suite (task 11). <!-- tracked: CMT-1536 (Phase 0 task 11 verification suite boots a server and observes the fold sweep) -->

Also fixed while resolving: the repo's no-silent-fallbacks lint counted catch blocks across the whole stack (515 vs a 494 baseline). Each slice now carries its own fix (slice 2 pushed to PR #3020; slices 5, 6 and 7a fix commits), and this change's two listing catches carry `@silent-fallback-ok` reasons; the stack is back at 494.

**Reviewer re-check (same reviewer, after the fixes):** "Concur with the review." Every resolution verified against the code; the tracked items need not block (no fold can begin in production). Four new MINOR notes, all fixed in this commit: (1) the runtime inbound-queue veto's `clearPisRecord` (server.ts) now also skips fold-tagged inject records; (2) `begin` writes the sidecar first and, if either write throws, removes what it wrote and releases the lock (no lockless record); (3) packet deletion is confined to the fold's own topic directory and never touches its `fold-records` (integration test: orphan pointers naming another topic's summary or a fold record delete nothing); (4) the breaker undercount on a re-settle is now stated above.

## Addendum (2026-11-10): topic-name ratchet

The boot sweep's two degradation-report strings named the fold's topic as a bare id; they now render it through `topicRef` (topic id plus its verified name, or "(name unresolved)"), as the topic-name ratchet requires. Text only: no decision, no new path, no behaviour change.
