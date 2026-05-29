# Side-Effects Review — TokenLedger 503 Alive Regression Guard

**Version / slug:** `tokenledger-503-alive-regression`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds an integration regression test for the TokenLedger 503 recovery paths and a narrow TokenLedger constructor seam used only by tests. The test seeds an old pre-attribution SQLite database, opens it through the real ledger, wires the real token route, and verifies `/tokens/summary` returns HTTP 200 with data. It also simulates a prior successful native sqlite heal by another subsystem and proves TokenLedger retries open cheaply and the route remains alive.

## Decision-point inventory

No runtime decision point is added or modified. The existing route decision of returning 503 when no ledger is configured is unchanged. The added constructor seam only changes how tests inject a database opener.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The test does not cover every TokenLedger route; it targets the summary route because that is the smallest alive signal for the two known 503 causes.

---

## 3. Level-of-abstraction fit

The test sits at the integration layer because the failure was endpoint unavailability, not only an internal helper result. The constructor seam is lower-level and narrowly scoped to the SQLite open boundary, which is the only place the native heal timing can be simulated without mutating installed dependencies.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change does not add a detector or an authority. It adds coverage for existing recovery behavior and one dependency injection seam.

---

## 5. Interactions

- **Shadowing:** No existing route behavior is shadowed. The route still checks for a configured ledger before reading summaries.
- **Double-fire:** The native-heal test asserts the opposite of double-fire: the simulated prior rebuild is consumed once, and TokenLedger does not start a second rebuild.
- **Races:** Temporary databases are per-test files. The NativeModuleHealer singleton is reset after each test.
- **Feedback loops:** None identified. The test does not feed production telemetry or persisted agent state.

---

## 6. External surfaces

No user-facing API shape changes. The only production type-surface change is the optional `databaseFactory` field on `TokenLedgerOptions`, which existing callers do not pass. Persistent state behavior is unchanged except that the test verifies the existing schema migration writes the missing column.

---

## 7. Rollback cost

Rollback is a normal revert. No production migration is added by this change. If the seam proved undesirable, removing it would only require deleting the integration test or replacing the injection strategy.

---

## Conclusion

The change is clear to ship. It strengthens coverage at the level where the regression was visible while keeping production behavior unchanged.

---

## Second-pass review (if required)

**Reviewer:** `not required`
**Independent read of the artifact:** `not required`

---

## Evidence pointers

- `tests/integration/tokens-503-regression.test.ts`
