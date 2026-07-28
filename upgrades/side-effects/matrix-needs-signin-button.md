# Side-Effects Review — Account matrix "Needs sign-in" → actionable Sign-in button

**Version / slug:** `matrix-needs-signin-button`
**Date:** `2026-06-20`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required (no block/allow surface, no lifecycle/gate/sentinel)`

## Summary of the change

The account × machine matrix in the Subscriptions dashboard had a cell-state, `needs-reauth` ("Needs sign-in"), that rendered as static text with no actionable control — a dead-end. This change (one branch condition + a button label in `dashboard/subscriptions.js`, plus one unit test in `tests/unit/subscriptions-render.test.ts`) moves `needs-reauth` into the actionable rendering branch so it draws the status word "⟳ Needs sign-in" AND a "Sign in" button directly below it. The button carries the same `data-matrix-setup` / `data-account-id` / `data-machine-id` attributes the empty-cell "Set up" button does, so it routes through the EXISTING, unchanged PIN-gated `start-cell` → sign-in-link → code-paste flow. No server route, authority, or data model is touched.

## Decision-point inventory

This change touches NO decision point. It is presentation logic only: it decides which DOM (a button vs plain text) to render for an already-computed cell state. The authority that gates starting a login (the dashboard-PIN check on `POST /subscription-pool/matrix/start-cell`) is unchanged and continues to be the sole gate.

- `renderAccountMatrix` cell rendering (`dashboard/subscriptions.js`) — modify — adds `needs-reauth` to the set of cell-states that render an actionable button; pure view logic, no gating.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change ADDS an affordance; it rejects nothing.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The PIN gate on `start-cell` is unchanged, so this adds no new path that bypasses authorization: tapping "Sign in" still requires the operator's PIN to actually start a login, exactly as "Set up" does.

---

## 3. Level-of-abstraction fit

Correct layer. This is a view-rendering concern living in the dashboard front-end, exactly where the sibling "Set up"/"Retry" button logic already lives. It re-uses the existing `start-cell` orchestrator rather than re-implementing any email-resolution / mandate / login logic — it feeds the smart gate that already exists instead of running parallel to it.

---

## 4. Signal vs authority compliance

Compliant. The change adds NO blocking authority and NO brittle decision logic. It renders a button that, when tapped, calls an existing PIN-gated authority (`start-cell`). The button itself holds no authority; the server endpoint remains the single authority and is untouched.

---

## 5. Interactions

- The new button uses the SAME delegated tap handler (`wireMatrixSetup` → `onSetupTap` → `onConfirmTap` → `start-cell`) as the empty-cell "Set up" button, so it cannot double-fire or shadow another handler — it is the same code path keyed on `data-matrix-setup`.
- `start-cell` already handles an existing account: it resolves the account email from the accountId (`resolveFollowMeEnrollTarget`) and has self-target idempotency that reuses an in-flight pending login. A needs-reauth account resolves to its email, so the flow drives a real re-auth and does not mint a duplicate when one is already pending.
- No race with adjacent cleanup: the cell re-renders from durable state each poll; an in-progress login transitions the cell to the in-progress (◷) state with its Cancel button, exactly as a "Set up"-initiated login does.

---

## 6. External surfaces

The only external surface is the dashboard UI: a `needs-reauth` cell now shows a "Sign in" button. No change to any API response, agent-to-agent surface, or other system. No new timing/conversation-state dependency — rendering is a pure function of the already-fetched pool/pending state.

### 6b. Operator-surface quality

This change EXISTS to improve operator-surface quality: it converts a non-actionable status into a one-tap action, matching the operator's directive that everything be actionable from the dashboard. The button label ("Sign in") matches the flow's existing vocabulary; the status word remains visible so the operator still understands WHY the action is offered.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local rendering of a pool-scope read, BY DESIGN. The matrix already reads `scope=pool` (peers merged) and the `start-cell` flow already delivers the mandate over the mesh for a peer-target cell. A needs-reauth cell on a PEER machine (e.g. the account expired on the Laptop while the Mini fronts the dashboard) routes its "Sign in" through the same proven cross-machine `start-cell` → peer enroll/start path the "Set up" button uses. No new replication or per-machine state is introduced; the change rides the existing cross-machine plumbing.

---

## 8. Rollback cost

Trivial. Revert the single commit (one branch condition + label + one test) — the cell returns to showing static "Needs sign-in" text. No data migration, no agent-state repair, no release coordination. Dashboard files ship static (no compiled artifact), so a revert is immediately effective on next deploy.
