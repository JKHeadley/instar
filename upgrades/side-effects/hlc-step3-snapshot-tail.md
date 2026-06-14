# Side-Effects Review — HLC Foundation Step 3 (snapshot-then-tail)

**Version / slug:** `hlc-step3-snapshot-tail`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `echo (Phase-5 reviewer subagent)`

## Summary of the change

Implements Component 4 (snapshot-then-tail) of the multi-machine replicated-store foundation (`docs/specs/multi-machine-replicated-store-foundation.md` §6). GENERIC substrate only — there is NO concrete store kind (preferences/relationships are later consumers). New `src/core/StoreSnapshot.ts` exports: `materializeSnapshot()` (single-origin materialization, §6.1/§6.2), the per-`(origin,kind)` seq-watermark VECTOR (§6.6), `applySnapshotCutover()` (seeds `lastHeldSeq = snapshotSeq` then rides the UNCHANGED `buildServeBatch` seq transport — §6.3, HLC demoted to secondary dedup §6.4), the deleted-keys high-water seed (§6.5 tombstone safety), `SnapshotCache` (fixed-ceiling LRU ring + `cacheLossCounter`, §8.2), `SnapshotRebuildBreaker` (§6.3 rebuild-storm bound), `StoreSnapshotEngine` (orchestrates an OFF-event-loop worker build mirroring `CartographerSweepEngine`, instar#1069), and `validateWireSnapshot()` (the receiver anti-forgery gate). New `src/core/storeSnapshotBuild.worker.ts` is the trivial worker entrypoint. `src/core/MeshRpc.ts` gains a `state-snapshot` read/observe verb. `src/commands/server.ts` constructs the engine + registers the dark-gated mesh handler. `src/core/stateSyncConfig.ts` + `src/config/ConfigDefaults.ts` reconcile `DEFAULT_MAX_CACHE_BYTES` 32 MiB → 64 MiB to match spec §8.2. Ships dark/additive behind `multiMachine.stateSync.*` (default false); a single-machine agent is a strict no-op.

## Decision-point inventory

- `validateWireSnapshot()` (receive-door anti-forgery) — **add** — rejects (returns null) any wire snapshot whose top-level/record/watermark `origin !== authenticated sender` (single-origin §6.1); the caller quarantines as untrusted-origin. Protects data, never blocks a user.
- `materializeSnapshot()` cross-origin drop — **add** — drops (counts) any own-stream entry whose `machine !== origin` at build time. Defense-in-depth, not a user gate.
- `applySnapshotCutover()` HLC-max merge + resurrection guard — **add** — a snapshot record is the winner only if HLC-greater than the present record AND not below the deleted-keys high-water. Mechanism, no user surface.
- `SnapshotRebuildBreaker.shouldRebuild()` — **add** — a build-side rate decision (serve cache / refuse) that bounds rebuild storms. Protects the holder's CPU; never touches user data.
- `MeshRpc` `state-snapshot` RBAC — **add (pass-through)** — read/observe class: any registered peer may issue it (same as journal-sync/preferences-sync). The single-origin invariant is the authority, not a role.
- `buildServeBatch` seq-contiguity — **pass-through** — the no-gap/no-double-apply guarantee is BORROWED unchanged from the existing applier; this change adds NO new gap-detection.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only block surface is `validateWireSnapshot()` at the receive door. It rejects a whole snapshot if any record's `origin` disagrees with the authenticated sender. A legitimate snapshot is ALWAYS single-origin by construction (the holder serves only its own authored records — the engine passes its own machine id as origin, never a peer field), so a well-formed snapshot from an honest peer is never rejected. A malformed/forged snapshot SHOULD be rejected — that is the §6.1 anti-forgery purpose. No legitimate input is over-blocked: a multi-origin store is recovered by snapshot-then-tailing EACH origin separately, each pull single-origin (§6.1), so the rejection of a cross-origin snapshot never blocks a real recovery.

---

## 2. Under-block

**What failure modes does this still miss?**

**[RESOLVED by the Phase-5 second-pass review — truncation-under-seed gap trap.]** The reviewer found a real correctness trap that the first-pass review missed: `materializeSnapshot()` truncates the records set when over `maxSnapshotBytes` but keeps the FULL `snapshotSeq` watermark. If a truncated snapshot were applied, the cutover would seed `lastHeldSeq = snapshotSeq` while the snapshot is MISSING records at-or-below that seq — and the subsequent tail (`seq > snapshotSeq`) would never replay them, a SILENT GAP the seq-contiguity cannot catch (it starts above them). Originally the code only FLAGGED `truncated` and no caller refused it, while `server.ts` armed `maxSnapshotBytes = maxCacheBytes` (64 MiB) — so a future WS2.1 consumer would have inherited an armed under-seed. **Folded fix (in THIS PR, where the trap is introduced):** the `truncated` flag now travels ON the `StoreSnapshot` itself (not just the serve-result envelope); `StoreSnapshotEngine.serveSnapshot` REFUSES a truncated build with `build-truncated` (never caches/serves it — the caller falls back to a from-genesis tail, the complete path), and `applySnapshotCutover` THROWS on a truncated snapshot (a structural backstop even against a buggy/old holder that serves one anyway). `validateWireSnapshot` carries the flag off the wire so the backstop holds end-to-end. Three new tests assert it (`tests/unit/StoreSnapshot.test.ts`: cutover throws on truncated, serve returns `build-truncated` + does not cache, wire carries the flag). The real fix for an over-cap store is its per-kind retention bound (§8), not a silent partial.

Beyond that: `validateWireSnapshot()` enforces origin === sender but does NOT cryptographically per-record-sign (the spec §6.1/§11.1 names per-record signing as the heavier "alternative B," explicitly NOT chosen). So a COMPROMISED peer M can still forge arbitrary records under `origin = M` (its OWN namespace) — bounded exactly as the steady-state tail's first-hop binding already allows, and the operator's recourse is rollback-unmerge (§7.4, a later step). This is the documented threat-model boundary (§11.1: "a compromised peer is bounded to corrupting records under ITS OWN origin"), not a gap this step introduces. The §6.4 secondary HLC-identity dedup is belt-and-suspenders only — it does not catch a record with a NEW (recordKey, origin, hlc) identity that is semantically a duplicate; that is correct, because the seq-contiguity (the primary mechanism) already handles it. No remaining under-block beyond the spec-acknowledged boundary.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Correct layer. The cutover deliberately RIDES the existing `JournalSyncApplier` seq-contiguity (lastHeldSeq+1) and `buildServeBatch` serve path rather than re-implementing gap detection — `applySnapshotCutover()` is injected with `CutoverApplierSeams` so it never duplicates the applier's logic; the real wiring binds those seams to the applier's PeerMeta. The off-event-loop build mirrors the established `CartographerSweepEngine`/`cartographerDetect.worker.ts` pattern (instar#1069) rather than inventing a new threading model. The cache + breaker are bounded primitives mirroring the quarantine ring's `lossCounter`. Nothing here re-implements a primitive that exists; it composes the existing transport.

---

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface over USER actions (it is pure mechanism: it orders, validates, caches, materializes, and un-merges; it never actuates and never decides a conflict winner).

The two refusals it does have — the receive-door anti-forgery rejection (`validateWireSnapshot`) and the build-side rebuild breaker — are both deterministic structural checks that protect the user's data / the holder's CPU, neither blocks a user-initiated action (spec §14: "No gate in this foundation blocks a user-initiated action"). The single-origin invariant is a STRUCTURAL property (origin === authenticated sender), not brittle content-pattern logic. The conflict-winner decision (the one judgment call) is explicitly deferred UP to the operator in a later step (`POST /state/resolve-conflict`, §7.3), not decided here.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The cutover seeds `PeerMeta.lastHeldSeq` then defers to the UNCHANGED applier serve/apply path — it does not shadow the existing seq-contiguity; it places the cursor and lets the existing rule run. The `seedLastHeldSeq` seam never LOWERS an already-advanced cursor (idempotent re-cutover does not rewind), so it cannot shadow steady-state replication progress.
- **Double-fire:** Re-running the whole snapshot-then-tail is safe (§6.3 step 5): the §6.4 HLC-identity dedup + the existing seq `duplicate` drop (seq ≤ lastHeldSeq) prevent double-apply. The unit test asserts a re-applied snapshot yields `applied: 0, dedupSkipped: N`.
- **Races:** The build runs on a worker thread and posts a single bounded result; the engine settles once (mirrors the cartographer worker's settle-once guard). The cache + breaker are main-thread, single-writer. No shared mutable state crosses the thread boundary (the worker receives a plain-object copy of `entriesByKind`).
- **Feedback loops:** A flapping peer that keeps requesting a rebuild is served the cache (within the min-interval) and rate-limited by the breaker (frequency cap → cooldown), so the request→rebuild loop is bounded across windows (the §12 #14 sustained-flapping invariant, covered by the breaker unit test).

In the Step-3 substrate the registry is EMPTY → the engine's `loadOwnEntries` returns no contributing kinds → the handler answers `no-entries` and the caller falls back to a from-genesis tail (the legacy behavior). So this change interacts with NOTHING at runtime until a concrete store (WS2.1) registers a kind.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Other users of the install base:** none — dark by default; with no `stateSync.<store>.enabled` flag set the engine has nothing to materialize and the mesh handler answers `no-entries`. Default config preserves today's behavior exactly.
- **External systems:** the `state-snapshot` pull rides the EXISTING authenticated mesh RPC (Cloudflare tunnel, no LAN/broadcast); no new external endpoint, no new network posture.
- **Persistent state:** none added by this step (the deleted-keys high-water + namespaced storage are consumed via injected seams; the real persistence lands with the consumer PR). The config reconcile (`maxCacheBytes` 32→64 MiB) backfills via `applyDefaults`/`migrateConfig` add-missing semantics (Migration Parity) — an operator's explicit value is never overwritten.
- **Timing/runtime conditions:** the build timeout (120 s default) + worker heap ceiling (1536 MB) bound the build; a timeout returns `build-timeout` (the caller falls back), never a hang.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added in this step. The future operator surfaces (conflict resolution, rollback-unmerge) land with later steps and will carry their own phone-completable surfaces. "No operator-facing actions" — valid here.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**When this agent runs on MORE THAN ONE machine, what is this feature's posture?**

**proxied-on-read** — this IS a cross-machine feature by design. A recovering machine PULLS a single-origin snapshot from a live holder of each origin's stream (the `state-snapshot` mesh verb), the holder builds it off-loop and may serve a cached copy. The merged read is the §7 union across per-origin namespaces (a later step); this step provides the snapshot PULL + cutover that populates one origin's namespace. Single-origin (§6.1) is the multi-machine security boundary: `origin === authenticated sender` holds end-to-end so a compromised peer cannot smuggle a foreign-origin record across the machine boundary.

- **User-facing notices:** none in this step (no one-voice gating needed).
- **Durable state on topic transfer:** the snapshot cache is machine-local + rebuildable (an eviction is a recompute, never a correctness loss), so it does not strand on transfer; the rollback-unmerge `dropOrigin` hook is provided for the later un-merge step.
- **URLs surviving machine boundaries:** none generated.

Phase-C (N machines, not 2): the snapshot is single-origin and the union is across N origins; the cache ceiling is a FIXED constant (NOT pool-scaled, §8.2) so a large pool rebuilds more often rather than growing the cache unboundedly; the rebuild breaker is per-(peer, origin, store) so N peers requesting the same snapshot are independent. The transport is mesh RPC (no LAN/broadcast). Scales to N cloud machines by construction.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change, dark by default — revert and ship a patch. No persistent state is written by this step (the seams are injected; the real persistence lands with the consumer). The config reconcile (`maxCacheBytes` 32→64 MiB) is a default bump; reverting it is another default change (no migration needed — `applyDefaults` add-missing leaves an operator's explicit value untouched either way). No user-visible regression during the rollback window because nothing user-facing is enabled. The `multiMachine.stateSync.<store>.enabled` per-store flags (all default false) are the kill switch — turning every store off returns to byte-for-byte today's behavior.

---

## Conclusion

This review confirms the change is pure, dark-by-default foundation mechanism with a single structural anti-forgery gate (`validateWireSnapshot`) that protects data and never blocks a user. The three requested adversarial lenses were applied: (1) **distributed-correctness / snapshot-cutover** — the no-gap/no-double-apply guarantee is borrowed unchanged from the existing seq-contiguity, HLC is correctly demoted to secondary dedup, and the watermark is a VECTOR (not a scalar) so a lagging stream is never silently excluded; idempotent re-cutover is asserted. (2) **cache-bounds / DoS** — the cache is a FIXED-ceiling LRU ring (count AND bytes, not pool-scaled) with a visible loss counter, and the per-peer rebuild breaker bounds rebuild storms across windows. (3) **integration-purity / Phase-C** — the build runs off the event loop in a worker (instar#1069), the transport is authenticated mesh RPC (no LAN), and every primitive is N-machine-correct. No design changes were required by the review. Clear to ship as dark/additive foundation.

---

## Second-pass review (if required)

**Reviewer:** echo (Phase-5 reviewer subagent)
**Independent read of the artifact: concern raised → resolved in this PR.**

The reviewer independently confirmed the artifact's core conclusions against the code: the watermark IS a genuine per-`(origin,kind)` vector (not a scalar — BLOCKER-1 honored); HLC IS demoted to secondary dedup (`tailCursorAfterCutover` returns `snapshotSeq`, never HLC); re-cutover is idempotent; the tombstone high-water is seeded before puts apply (correct ordering, blocks resurrection); the cache is fixed-ceiling (count AND bytes, not pool-scaled) with `cacheLossCounter` bumping only on real LRU eviction (not on supersede); the breaker resets+cooldowns across windows; the build runs off the event loop in a real worker with a minimal secret-free env; single-origin is enforced end-to-end (materialize drops cross-origin AND `validateWireSnapshot` rejects it); the server handler passes the holder's OWN machine id as origin; the transport is authenticated mesh RPC; and there is no signal-vs-authority violation (no user-action gate).

**Concern raised:** the truncation-under-seed gap trap (detailed in §2 above) — a truncated snapshot kept the full `snapshotSeq` but no caller refused it, and `server.ts` armed `maxSnapshotBytes` to 64 MiB, so a future WS2.1 consumer would have seeded `lastHeldSeq` past dropped records, creating a silent sub-watermark gap that contradicts the "no-gap guarantee borrowed from seq-contiguity." The reviewer recommended closing the contract structurally in this PR (where the trap is introduced).

**Resolution (folded in this PR):** `truncated` now travels on the `StoreSnapshot`; `serveSnapshot` refuses with `build-truncated` (never caches/serves); `applySnapshotCutover` throws on a truncated snapshot; `validateWireSnapshot` carries the flag — a structural, end-to-end refusal so a consumer cannot under-seed by construction. Three new tests lock it. Concern resolved.

---

## Evidence pointers

- Unit: `tests/unit/StoreSnapshot.test.ts` (26 tests — materialization/anti-forgery, cutover/idempotency, tombstone-resurrection drop, wire-validation forgery rejection, cache LRU + lossCounter, breaker across windows, engine orchestration). Green.
- Integration: `tests/integration/store-snapshot-mesh.test.ts` (5 tests — REAL dist off-loop worker build + event-loop-lag<250ms proof; full mesh dispatcher verify→rbac→handler round-trip; substrate no-entries no-op). Green.
- RBAC ratchet: `tests/unit/MeshRpc.test.ts` (state-snapshot read/observe RBAC). Green.
- Gates: `tsc --noEmit` clean; `no-silent-fallbacks` green (3 untrusted-wire-reject catches tagged `@silent-fallback-ok`); `lint-dev-agent-dark-gate` green (16); `feature-delivery-completeness` green (95); `docs-coverage --check` exit 0 (StoreSnapshot sections added to multi-machine.md + under-the-hood.md).
