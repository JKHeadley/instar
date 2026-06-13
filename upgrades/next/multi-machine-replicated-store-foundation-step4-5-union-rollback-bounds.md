# Replicated-store foundation — Step 4 (union-reader + rollback) + Step 5 (bounds)

<!-- bump: patch -->

<!--
  NOTE: this is internal substrate (dark, no user-facing surface) — Steps 4+5 of
  the multi-machine replicated-store foundation. The change touches runtime src/
  (5 new core modules, 3 new HTTP routes, server wiring, migration + awareness), so
  the <!-- internal-only --> tests/docs-only lane does not apply. The user-facing
  sections below honestly state "None — internal substrate"; the CLAUDE.md "One
  Memory" awareness section is added so a FUTURE consumer (WS2.1) surfaces it, but
  no store replicates yet (the kind registry ships empty).
-->

## What Changed

The **union-reader + origin-tagged rollback-unmerge + aggregate bounds** for cross-machine memory stores — Components 6+7 of the foundation, on top of the Step 1–3 substrate (HLC, replicated-record envelope, snapshot-then-tail). Per `docs/specs/multi-machine-replicated-store-foundation.md` §7 + §8.

- **The no-clobber union-reader + a SOUND concurrency detector** (`src/core/UnionReader.ts`) — a store read returns the UNION of every machine's per-origin records, merged by a no-clobber rule. Concurrency is decided by a **last-writer-witness** (each record carries the HLC it had already merged for that key — `compare(w2.observed[K], w1.hlc) >= 0`), NEVER a scalar HLC compare (which is a total order and would silently clobber a genuine concurrent divergence — this closes BLOCKER-4). A missing/below witness flags, never resolves (provable err-toward-flag). High-impact stores (preferences, relationships) get **append-both-and-flag** with a stable `conflictId`; low-impact stores get HLC-wins WITH a divergence flag. N concurrent edits produce ONE conflict with all N versions, never N-choose-2.
- **The bypass-proof funnel** (`src/core/ReplicatedStoreReader.ts`) — the single lowest store-access primitive every read routes through, so no caller can sidestep the union (wiring-integrity enforced by test).
- **Durable conflict ledger + operator resolution** (`src/core/ConflictStore.ts`, routes `GET /state/conflicts`, `POST /state/resolve-conflict`) — idempotent on `conflictId`, recurrence → forced-resolution, ONE deduped attention item. The foundation NEVER picks a winner — the operator does (Signal vs Authority).
- **Deterministic rollback-unmerge** (`src/core/RollbackUnmerge.ts`, route `GET /state/quarantine`) — disabling `multiMachine.stateSync.<store>` for a peer DROPS that origin from the live union (zero dangling refs — the union recomputes, a key reverts to the latest among the remaining origins or to "no record"), quarantines-aside its streams/meta/snapshot-cache (rename + bounded-retain; the prune leg through `SafeFsExecutor`, never a destructive delete), and auto-resolves conflicts that referenced it. Reversible.
- **Aggregate bounds + Phase-C scaling** (`src/core/ReplicationBudget.ts`) — coalescing (replicate the latest state per key per interval), an aggregate cross-kind fair-share throttle (a flood on one kind cannot starve another; surfaced in degradation, never a silent stall), Phase-C budget = per-peer × live online-peer-count with a hard ceiling + rise-hysteresis, and a tombstone-horizon forced full-snapshot re-join (the delete-resurrection guard).

Pure MECHANISM, dark by default (`multiMachine.stateSync.<store>`, default false). No new `enabled:` literal under multiMachine, so the dark-gate line-map is unchanged. The only refusals are the `/state/resolve-conflict` input validation (operator authority) and the inherited receive-door anti-forgery; neither blocks a user-initiated action. A single-machine install (empty kind registry) is a strict no-op.

## What to Tell Your User

None — internal substrate (no user-facing surface yet). The cross-machine memory features that USERS will notice (one memory across machines: preferences/relationships that follow them, with two-version conflicts they can resolve, and a "roll back machine Y's data" lever) become real when the first concrete store (WS2.1) consumes this foundation.

## Summary of New Capabilities

None user-facing. New internal modules: `UnionReader.ts`, `ReplicatedStoreReader.ts`, `ConflictStore.ts`, `RollbackUnmerge.ts` (+ `DroppedOriginRegistry`), `ReplicationBudget.ts`. New dark routes: `GET /state/conflicts`, `GET /state/quarantine`, `POST /state/resolve-conflict` (503 until a store is enabled). All dark by default.

## Evidence

- `tests/unit/UnionReader.test.ts` — the BLOCKER-4 detector incl. §12 #5 ADVERSARIAL-clock (a pair whose wall-clock `compare` resolves cleanly but whose witnesses prove neither saw the other MUST flag), no-clobber merge each branch, N-machine version set, stable order-independent `conflictId`. Green.
- `tests/unit/ConflictStore.test.ts`, `RollbackUnmerge.test.ts` (§12 #6 zero-dangling-refs + reversible + bounded-retain prune through SafeFsExecutor), `ReplicatedStoreReader.test.ts` (§12 #11 wiring-integrity — deps not null/no-op), `ReplicationBudget.test.ts` (§12 #9/#15 cross-kind anti-starvation, §8.1 Phase-C scaling + hysteresis, #13 tombstone-horizon). Green.
- `tests/integration/state-sync-routes.test.ts` (503-dark / 200-alive / 404 / 400 / Bearer), `state-sync-burst-invariant.test.ts` (§12 #10 — ONE attention per conflictId under a storm). Green.
- `tests/e2e/state-sync-union-alive.test.ts` — feature-alive on the real AgentServer init path: a union-detected conflict is open + readable + operator-resolvable over HTTP, rollback auto-closes a conflict + drops the origin from the union live, 503 when dark, Bearer auth. Green.
- Gates: `tsc --noEmit` clean; full project `lint` green (incl. destructive-fs funnel + dark-gate line-map UNCHANGED); `no-silent-fallbacks` green (all fail-toward-safe catches tagged); `feature-delivery-completeness` green (One Memory section: template + migrator + shadow markers, three-way parity); `docs-coverage --check` exit 0.
