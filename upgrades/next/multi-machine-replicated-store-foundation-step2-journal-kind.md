# Replicated-store foundation — Step 2 (journal-kind tagging + flag-gated emission)

<!-- bump: patch -->

<!--
  NOTE: this is internal substrate (dark, no user-facing surface) — Step 2 of the
  multi-machine replicated-store foundation. The <!-- internal-only --> ship lane
  is NOT used here because this change touches runtime src/ (new core modules,
  types, config, server wiring), and the pre-push gate §3c reserves that lane for
  tests/docs/scripts-only changes. So the user-facing sections below honestly state
  "None — internal substrate".
-->

## What Changed

The generic machinery that future cross-machine memory stores (preferences, relationships, learnings, …) will plug into. This step builds the reusable substrate ONLY — it adds no concrete store kind (that lands with the first store, WS2.1).

- **Replicated-record envelope** (`src/core/ReplicatedRecordEnvelope.ts`) — the fields every replicated change carries on top of its store-specific data: `recordKey`, the `HybridLogicalClock` stamp (`hlc`), a `put`/`delete` `op`, the author machine (`origin`), and the single prior stamp the author had already merged for that key (`observed` — the last-writer-witness; absent ⇒ "no prior witness" ⇒ flag-on-conflict, the safe direction). A strict, parameterizable validator mirrors the coherence-journal typed-schema discipline (rejects free text, drops + counts unknown fields, jails path-shaped fields, validates the HLC fields). A `ReplicatedKindRegistry` (ships EMPTY) is the registration mechanism each store will use.
- **Flag-gated emission (dark per store)** — a store emits its kind only when `multiMachine.stateSync.<store>.enabled` is on (default false). When off, no journal traffic — a strict no-op.
- **Flag-coherence-gated emission** — a kind is forwarded to a peer ONLY when that peer advertises (`seamlessnessFlags.stateSyncReceive`) it can receive it. Emitting a new kind to an older peer would be silently dropped by the applier — the named data-loss skew mode this gate prevents. The per-peer decision is correct for N peers; a boot-time pool-flag-coherence check surfaces a mixed-flag pool ONCE, coalesced.
- **Config + invariants** (`src/core/stateSyncConfig.ts`, `ConfigDefaults.ts`, `types.ts`) — the foundation-level `multiMachine.stateSync` knobs (journal budget, the §3.4 HLC drift ceiling, snapshot-cache bounds), validated at startup by `validateStateSyncInvariants()` (an out-of-range value is REJECTED, not silently coerced), backfilled to existing agents via the add-missing migration path.

Pure MECHANISM, dark by default. The only two refusal surfaces are at the receive door (the validator rejects malformed data) and the emission door (don't forward to a non-advertising peer); neither blocks a user-initiated action. A single-machine install is a strict no-op.

## What to Tell Your User

None — internal substrate (no user-facing surface). The replicated cross-machine memory stores that this foundation enables ship later, store by store, each with its own announcement when its user-facing surface (conflict viewing, rollback) lands.

## Summary of New Capabilities

None — internal change. This is the reusable substrate the first concrete replicated store (the cross-machine preferences pool, WS2.1) will register a journal kind onto; it exposes no new endpoint, config a user would set, or behavior a user would notice until a store turns its flag on.

## Evidence

Tier-1 unit tests in `tests/unit/ReplicatedRecordEnvelope.test.ts` (46 tests, all green) cover both sides of every boundary: the validator (valid put/delete; missing recordKey/hlc; malformed hlc; observed present-valid / present-malformed-rejected / absent-legal; unknown-field-dropped-and-counted; path-shaped field jailed; non-object/free-text rejected; store-schema rejection), the registry (empty default, unregistered-kind absent, conflict-throws, idempotent re-register), flag-gated emission (enabled=false ⇒ no emission; enabled=true ⇒ emits), flag-coherence (advertising ⇒ emit; non-advertising ⇒ withhold + surface; 3+-peer mix ⇒ per-peer correctness + ONE coalesced surface), `validateStateSyncInvariants` (maxDriftMs floor/ceiling/in-range), and a wiring-integrity case for the advert self-report (driven by registered+enabled stores, never a hardcoded true).

Gate-parity (run in the worktree): `tsc --noEmit` clean; `no-silent-fallbacks` = 471 (= BASELINE, no bump — the new files carry no un-tagged silent catches); `docs-coverage --check` PASS (class floor 55% held — `ReplicatedRecordEnvelope` documented in `multi-machine.md` + `under-the-hood.md`); `feature-delivery-completeness` PASS; `lint-dev-agent-dark-gate` PASS (the config line-map recomputed for the +17 cartographer shift); focused suites `CoherenceJournal*` / `JournalSyncApplier*` / `CoherenceJournalReader` + the new test all green.
