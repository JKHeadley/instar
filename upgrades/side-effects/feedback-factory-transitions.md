# Side-Effects Review — feedback-factory lifecycle state machine (Phase 1, increment 3)

**Slug:** `feedback-factory-transitions`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The pure lifecycle decision logic — `V2_STATES`/`V2_TRANSITIONS`/`TRANSITION_GATES` constants, `can_transition` (:1045, scar a's evidence gate + the state machine + chronic circuit-breaker), and `detect_cycling` (:1139). The DB-coupled drivers (`cmd_transition`, the version-anchored half of `can_transition_to_verified`) are later increments.

## Summary of the change

Byte-exact port of the above from `the-portal/.claude/scripts/feedback-processor.py` to `src/feedback-factory/processor/transitions.ts`. Pure functions, no I/O. **Not wired into any route/job yet** — no behavioral change. Adds the transitions parity harness + Tier-1 unit tests.

This is the heart of scar (a): the evidence gate (terminal transitions to `wontfix`/`closed`/`chronic_escalated` require ≥20-char justification — unified with the `clusters.ts` API hard gate) and the chronic circuit-breaker (auto-block `chronic` at `recurrenceCount ≥ 3`, forcing `chronic_escalated`).

## Equivalence verification

- **33/33 cases match the reference Python** — both the `allowed` decision AND the exact `reason` string (the reasons interpolate Python's `sorted(set)` list-repr; the port reproduces it via `pyListRepr` so even the diagnostic text is byte-identical), plus all `detect_cycling` results.
- The check ORDER is preserved exactly (invalid target → unknown current → illegal transition → evidence gate → hard gate → chronic breaker), so the first-failing reason matches the reference for every case.

## Seven-dimension review

1. **Over/under-reach** — Pure deterministic functions, no I/O, no global state, not imported by any runtime path. Cannot affect existing behavior. The constants are exported read-only.
2. **Level-of-abstraction fit** — Processor-logic layer, alongside the fingerprint + similarity ports. Correct home. The state machine is data (constants) + a pure validator — no DB coupling, which is why it ports cleanly now (the DB-coupled verification driver waits for the data layer).
3. **Signal vs Authority** — `can_transition` is the structural evidence gate (scar a): it *enforces* that terminal transitions carry evidence, mirroring the `clusters.ts` API hard gate. This is legitimate authority that already exists in the reference (not new authority introduced by the port). The processor still never force-closes; it validates.
4. **Interactions** — None. New isolated module; nothing imports it yet. Parity scripts are LOCAL-only (external reference path via `PORTAL_PROCESSOR`).
5. **Rollback cost** — Trivial: delete the module + tests + scripts.
6. **Migration parity** — N/A. New internal library code; touches no agent-installed file.
7. **Failure modes** — (a) Port diverges from reference → caught by the parity harness (33/33, decisions+reasons+cycling) + unit assertions in CI. (b) A new lifecycle state added to the reference but not the port → the "every transition target is a known state" unit test + future parity runs catch drift; Dawn's review is the human backstop. (c) Reason-string repr divergence → parity asserts reasons byte-for-byte.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/transitions.test.ts` — state legality, terminal states, evidence gate (both sides of 20 chars), dispatch hard gate, chronic circuit-breaker (recurrence 2 vs 3), cycling detection, constants integrity. 12 tests.
- Parity (local gate, evidence): `scripts/feedback-factory/transitions-parity.mjs` → **33/33** decisions + reasons + cycling identical to the reference Python.
- No integration/E2E this increment: not yet wired to a route/job; those tiers attach with the clustering/transition driver. Reasoned decision, documented.
