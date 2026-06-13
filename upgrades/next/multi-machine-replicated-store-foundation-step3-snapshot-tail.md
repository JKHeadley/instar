# Replicated-store foundation — Step 3 (snapshot-then-tail)

<!-- bump: patch -->

<!--
  NOTE: this is internal substrate (dark, no user-facing surface) — Step 3 of the
  multi-machine replicated-store foundation. The <!-- internal-only --> ship lane
  is NOT used here because this change touches runtime src/ (new core modules, a
  new mesh verb, server wiring, config), and the pre-push gate reserves that lane
  for tests/docs/scripts-only changes. So the user-facing sections below honestly
  state "None — internal substrate".
-->

## What Changed

The **snapshot-then-tail** join/recover path for cross-machine memory stores — so a returning / compacted / long-dark machine never replays a peer's journal from genesis. This step builds the GENERIC substrate ONLY; it adds no concrete store kind (that lands with the first store, WS2.1). Per `docs/specs/multi-machine-replicated-store-foundation.md` §6 / §8.2.

- **Single-origin snapshots** (`src/core/StoreSnapshot.ts`) — a peer materializes the current state of the records **it itself authored** (`origin === serving machine`, the first-hop anti-forgery invariant enforced at build AND at the receive door, so a compromised peer can never smuggle a record under another machine's name). A multi-origin store is recovered by snapshot-then-tailing each origin separately.
- **Seq-watermark VECTOR + the cutover** — the snapshot carries a per-`(origin, kind)` sequence watermark (not a scalar — a scalar would silently lose a lagging stream's record). `applySnapshotCutover()` seeds the applier's cursor to that watermark, then tails the UNCHANGED `buildServeBatch` seq transport, so the no-gap / no-double-apply guarantee is inherited from the existing seq-contiguity. The hybrid logical clock is demoted to a belt-and-suspenders duplicate filter. Re-running the whole snapshot-then-tail is idempotent.
- **Tombstone safety** — a per-key deleted-keys high-water seed blocks a stale pre-delete edit from resurrecting a key after the tombstone record itself rotates out.
- **Off-event-loop build + bounded cache** — `StoreSnapshotEngine` runs the whole-store materialization in a worker thread (the instar#1069 discipline, mirroring `CartographerSweepEngine`); `SnapshotCache` is a fixed-ceiling LRU ring (count AND bytes, NOT pool-scaled) with a `cacheLossCounter`, and `SnapshotRebuildBreaker` bounds rebuild storms from a flapping peer. An over-cap (truncated) build is a HARD REFUSAL — never a silent partial — so a consumer can never seed the cursor past dropped records.
- **Mesh verb + config** — a new `state-snapshot` read/observe verb (`src/core/MeshRpc.ts`) pulls the snapshot over the existing authenticated mesh RPC (no LAN/broadcast — scales to N cloud machines). `DEFAULT_MAX_CACHE_BYTES` reconciled 32 MiB → 64 MiB to match spec §8.2.

Pure MECHANISM, dark by default (`multiMachine.stateSync.*`, default false). The only refusal surfaces are at the receive door (anti-forgery) and the build door (rebuild breaker / truncation refusal); neither blocks a user-initiated action. A single-machine install is a strict no-op (no peer to pull from, nothing to materialize).

## What to Tell Your User

None — internal substrate (no user-facing surface). The cross-machine memory features that USERS will notice (preferences/relationships following them across machines) land in later WS2.x steps that consume this foundation.

## Summary of New Capabilities

None — internal substrate. New internal modules: `StoreSnapshot.ts` (single-origin snapshot + cutover + cache + rebuild breaker), `storeSnapshotBuild.worker.ts` (off-loop build worker), the `state-snapshot` mesh verb. All dark by default; no new user-facing API surface.

## Evidence

- `tests/unit/StoreSnapshot.test.ts` — single-origin anti-forgery (cross-origin entries dropped at build; wire snapshot with any foreign-origin record rejected wholesale), per-`(origin,kind)` watermark-vector correctness, seq-driven cutover completeness across a simulated multi-origin pool + idempotent re-apply, tombstone-resurrection drop, cache LRU eviction + `cacheLossCounter` (count + byte ceilings), rebuild breaker bounded across windows (reset + cooldown), and truncation-refusal (cutover throws, serve returns `build-truncated` + does not cache). Green.
- `tests/integration/store-snapshot-mesh.test.ts` — the REAL compiled off-event-loop worker (dist) builds a bounded snapshot and a 60k-record build keeps main-loop lag < 250 ms (the instar#1069 proof); the `state-snapshot` verb flows through the full mesh dispatcher (verify → RBAC → handler) and serves a single-origin snapshot; the Step-3 substrate (empty registry) answers `no-entries` (strict no-op). Green.
- `tests/unit/MeshRpc.test.ts` — `state-snapshot` is read/observe RBAC class (any registered peer; self-binding, no router/owner role). Green.
- Gates: `tsc --noEmit` clean; `no-silent-fallbacks` green (untrusted-wire-reject catches tagged); `lint-dev-agent-dark-gate` green; `docs-coverage --check` exit 0 (StoreSnapshot sections added to `multi-machine.md` + `under-the-hood.md`).
