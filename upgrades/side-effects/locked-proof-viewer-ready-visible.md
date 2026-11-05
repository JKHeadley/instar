# Side-Effects Review — locked-proof driver waits for a visible viewer control

**Tier 1.** One selector constant in proof tooling plus one updated and one new unit assertion. Size: 2 code files (+11/−3), with the release note, side-effects and ELI16, 5 files. Effort: no spec rounds, first commit attempt.

## Summary

- `VIEWER_READY` in `scripts/locked-proof/driver.mjs` changes from `'#requestButton:not([disabled]), #control:not([hidden])'` to `'#requestButton:not([disabled]):visible, #control:visible'`.
- Cause: Playwright's `waitForSelector` follows the first element a selector list resolves to. `dashboard/desktop.js` opens the stream by itself when exactly one machine is ready and hides `#request`, but leaves `#requestButton` enabled, so the wait followed a hidden button and timed out (live, Mac Mini, 2026-11-05).
- Tests: the existing assertion is updated to the new strings, and a new one requires every alternative to end in `:visible`.

## 1. Over-block

None identified. `:visible` is satisfied by both real ready states: the request button shown with a selectable machine, or the open control panel. A page that shows neither is not ready, which the old selector also meant.

## 2. Under-block

The wait still cannot tell an open stream that later fails from a healthy one; later steps (`#control:not([hidden])` in `openGrant`, the password box wait) cover that, unchanged.

## 3. Level-of-abstraction fit

Right layer: the driver's own readiness selector. The page behaviour (auto-open, hidden button kept enabled) is correct for people and is not changed to suit the test.

## 4. Signal vs authority compliance

No decision point. A test-harness wait condition; it gates nothing in an agent. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

`requestGrant` still checks `isVisible('#control')` before clicking, so the flow after the wait is unchanged. No other caller uses `VIEWER_READY`.

## 6. External surfaces

None. The driver is run by hand on a proof machine; nothing ships to agents.

## 6b. Operator-surface quality

No page or control changes.

## 7. Multi-machine posture

Machine-local by design: the driver runs on the one Mac under test against its local proof agents.

## 8. Rollback cost

A revert restores the old selector and tests. No state or migration.
