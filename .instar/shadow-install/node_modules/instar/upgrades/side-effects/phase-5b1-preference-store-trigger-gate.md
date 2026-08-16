# Side-effects review — Phase 5b.1 (PreferenceStore + TriggerGate)

**Version / slug:** `phase-5b1-preference-store-trigger-gate`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (pure storage + pure logic, complete branch coverage in unit tests)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md` (Phase 5b spec, locked + approved 2026-05-15)

## Summary of the change

First implementation slice of Phase 5b. Lands the two purely-deterministic components that the UX rides on:

1. **`PreferenceStore`** (`src/providers/uxConfirm/PreferenceStore.ts`) — sqlite-backed cache keyed by `(userId, taskPattern)`. Stores the framework+model pick plus the state-at-confirm-time fields the TriggerGate needs (cost-state snapshot, catalog version, confidence). Provides `get`, `set`, `clear`, `clearAll`, `listPatterns`. Uses `better-sqlite3` per the existing instar storage pattern (StopGateDb, FeatureRegistry, UpdateChecker). Supports `:memory:` for tests.

2. **`TriggerGate`** (`src/providers/uxConfirm/TriggerGate.ts`) — pure function `runTriggerGate(inputs)` that returns one of four discriminated outcomes: `silent-use`, `ask-new-pattern`, `ask-cost-shift`, `ask-low-confidence`. Priority order matches the spec: new-pattern > cost-shift > low-confidence > silent-use. Composes with `CostStateTracker.isMaterialShift` from Phase 5c.

The other Phase 5b components (TaskClassifier, TelegramConfirmer, OverrideDetector, FrameworkModelRouter composition root) are deferred to subsequent slices.

Files touched:
- `src/providers/uxConfirm/PreferenceStore.ts` — new, 162 LOC.
- `src/providers/uxConfirm/TriggerGate.ts` — new, 132 LOC.
- `tests/unit/providers/uxConfirm/PreferenceStore.test.ts` — new, 11 cases.
- `tests/unit/providers/uxConfirm/TriggerGate.test.ts` — new, 12 cases.

## Decision-point inventory

This change ADDS the central decision point of Phase 5b — the gate that decides whether to ask the user. The store is supporting infrastructure.

- **`runTriggerGate(inputs) → outcome`** — `add`. Pure function. No blocking authority of its own; returns an outcome that the (not-yet-implemented) UX layer interprets. Per signal-vs-authority, the gate is the deterministic policy and the UX is the surface — they're correctly separated.
- **`PreferenceStore.{get,set,clear,clearAll,listPatterns}`** — `add`. Storage primitives. No decision logic.

The four-outcome shape (`silent-use | ask-new-pattern | ask-cost-shift | ask-low-confidence`) is the contract the UX consumes. It is exhaustive — every input produces exactly one outcome.

## Signal vs authority

- `runTriggerGate` is a stateless function. Inputs include cached preference, current cost-state snapshot, current catalog version, current confidence. Output is the outcome. No side effects, no blocking — purely a decision producer.
- `PreferenceStore` is storage. It doesn't decide anything; it just persists what the user confirmed. Cache invalidation is the gate's job.
- The split keeps the UX layer free of decision logic: it just renders the outcome.

## Over-block / under-block analysis

**Over-block (asking too often):**
- A catalog version that bumps for cosmetic reasons (typo fix, doc shuffle) would trigger ask-low-confidence even when no fitness data changed. Mitigated by spec §"Open questions deferred to Phase 5c" — version bumps should only fire on meaningful catalog changes. Operationally, the catalog author decides.
- A user with a flaky `readSdkCredit` could see false ask-cost-shift outcomes if the snapshot bounces around. Mitigated by Phase 5c's known→unknown transition detector — bouncing snapshots produce the same "state-became-unknown" reason and the user can ignore it.

**Under-block (not asking when we should):**
- A catalog edit that drops confidence without bumping the version string would NOT fire the gate. By convention (spec §"Acceptance criteria #4"), version bump is mandatory when confidence changes — but conventions aren't enforced. Future hardening: store a checksum of the catalog row, not just the version string. Deferred.
- A user who confirmed during a billing period that then resets: the new snapshot will have totalUsd back to full, remainingUsd back to full. The tracker reports `sdk-credit-state-became-known` if reset went via null, or `recovered-above-safety-margin` if no null in between. Both are material shifts that fire the gate — so this is correctly handled.

## Level-of-abstraction fit

- The store and gate live in a new `src/providers/uxConfirm/` directory parallel to `src/providers/`. The naming signals that this is the consume-and-confirm UX surface — distinct from the routing math (`costAwareRouting.ts`) and the registry primitives.
- `TriggerGate` imports `CostStateTracker` from Phase 5c. This is the documented integration point.
- `PreferenceStore` imports nothing from `src/core/` except types — keeps the provider-portability subsystem self-contained.

## Interactions

- **Phase 5c (`CostStateTracker`)** — `TriggerGate` calls `isMaterialShift` to detect cost-shift triggers. Composes cleanly.
- **Phase 5a (catalogs)** — `confidenceAtCache` uses the catalog's confidence label scheme (`HIGH | MEDIUM | LOW | PROVISIONAL`). When the Phase 5a artifacts evolve, the gate keeps working as long as those labels remain the canonical scheme.
- **No existing source file is modified.** This commit is purely additive.

## External surfaces

- New exports: `PreferenceStore`, `FrameworkModelPreference`, `PreferenceStoreOptions`, `ConfidenceLevel`, `runTriggerGate`, `TriggerGateInputs`, `TriggerGateOutcome`.
- New sqlite table when applied to a state directory: `framework_model_preferences` (created on first use via `CREATE TABLE IF NOT EXISTS`).
- No new endpoint, no new CLI command, no new config field.

## Rollback cost

Trivial. `git revert` removes four files. The sqlite file (when one is created in production) becomes orphaned but does no harm — no runtime code consumes the schema yet in this commit (the composition root wiring happens later). Future rollbacks after wiring would also be safe since the schema is `CREATE IF NOT EXISTS`.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/` — 23/23 pass (11 store, 12 gate).
- Gate test coverage: every priority path (new-pattern, cost-shift, low-confidence-dropped, low-confidence-LOW, low-confidence-PROVISIONAL, silent-use, version-bumped-but-confidence-unchanged) has at least one case plus three priority-ordering cases.
- Store test coverage: get/set/clear/clearAll/listPatterns, per-user isolation, JSON roundtrip for `CostStateSnapshot`, null `agentSdkCredit` roundtrip, overwrite-on-duplicate.
- No real-API verification needed — both classes are deterministic pure-logic / storage. Wiring into a live runtime is a later slice.
