# Side-Effects Review — Dashboard Secrets tab

**Version / slug:** `dashboard-secrets-tab`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds a "Secrets" tab to the Instar dashboard that surfaces Secret Drop state to the user: a list of currently pending secret requests with per-item live countdown, an "Open drop link" shortcut, per-item Cancel button, and a "Create test request" button for verification. The tab is positioned after "Send Content" and before "Jobs" for prominence. The implementation is pure dashboard — HTML, DOM-building JS, and a 1-second ticker — against the existing `/secrets/pending`, `/secrets/request`, and `/secrets/pending/:token` endpoints. No server code is added or modified.

Files touched:
- `dashboard/index.html` — tab button, panel div, TAB_REGISTRY entry, `loadSecrets()`, ticker, `createTestSecretRequest()`.
- `tests/unit/dashboard-secretsTab.test.ts` — smoke tests mirroring the initiatives pattern (tab wiring, loader definition, endpoint usage, XSS invariant).

## Decision-point inventory

This change has no decision-point surface. It is a read-only presentation layer plus two user-initiated actions (create-test, cancel) that call existing routes. No gating, filtering, blocking, or routing logic is introduced.

- *(none — presentation-only)*

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

This is presentation on top of existing transport endpoints. The right layer: the dashboard already owns other read-only capability views (Initiatives, Commitments, PR Pipeline), and the Secrets tab follows that pattern exactly — TAB_REGISTRY entry, panel div, async loader, textContent-only rendering. No new primitive, no duplication of an existing view. The live-countdown ticker is a tab-local concern and is started/stopped by the tab's own activate/deactivate hooks, matching the precedent set by `integratedBeingPollTimer`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The tab reads `/secrets/pending` and displays it. The "Create test request" button calls `/secrets/request` with user-initiated intent. The Cancel button calls `DELETE /secrets/pending/:token` with user-initiated intent. None of these are judgment decisions about meaning or agent intent; they are direct user actions mediated by the dashboard. The underlying endpoints already enforce their own structural validation (label length, ttl bounds, concurrent-request cap).

---

## 5. Interactions

- **Shadowing:** None. The tab renders its own panel and does not wrap or intercept any other tab's flow. `switchTab()` handles panel visibility via the existing TAB_REGISTRY.
- **Double-fire:** The ticker is a 1-second interval that updates DOM textContent of elements keyed by `secretCountdown-${token}`. Elements missing from the DOM short-circuit. `startSecretsTicker()` calls `stopSecretsTicker()` first to prevent double-registration if a user rapidly switches tabs. `onDeactivate` clears the ticker.
- **Races:** The ticker reads from `secretsLastPending` (module-level) which is rewritten on each `loadSecrets()` call. Worst case under rapid switch + reload: a tick runs against stale data and updates countdowns by one extra second before the next reload; no correctness impact.
- **Feedback loops:** None — the tab is a read surface. The only write actions are user-initiated (create-test, cancel). Creating a test request will occupy one of the 20 concurrent-request slots for up to 5 minutes; server-side rate limiting is unchanged and enforces the cap.

---

## 6. External surfaces

- **Other agents on the same machine:** No change. Secret Drop state is per-agent-server.
- **Other users of the install base:** New dashboard tab appears on version upgrade. Additive — no existing UI element is removed or repositioned except the visible gap between "Send Content" and "Jobs" which now contains the new button.
- **External systems:** None. No new outbound calls.
- **Persistent state:** None. Secret Drop state is in-memory by design; this change does not persist anything.
- **Timing/runtime:** The 1-second ticker runs only while the Secrets tab is active. Negligible CPU.

---

## 7. Rollback cost

Pure presentation change. Revert the two file changes (`dashboard/index.html`, new test file) and ship as a patch. No data migration, no agent state repair, no user-visible regression beyond the tab disappearing.

---

## Conclusion

Straightforward additive UI work that gives users and agents eyes on Secret Drop state. No decision-point surface; signal-vs-authority does not apply. Existing endpoint tests cover the backend (25 tests in `SecretDrop.test.ts` still passing). New dashboard smoke tests (12) exercise the HTML-level invariants — tab wiring, loader presence, endpoint usage, XSS safety — matching the pattern established for Initiatives and PR Pipeline tabs. Safe to ship.

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/dashboard-secretsTab.test.ts` → 12/12 passed.
- Regression sanity: `dashboard-initiativesTab`, `dashboard-prPipelineTab`, `dashboard-resumeLive`, `SecretDrop` → 49/49 passed together.
