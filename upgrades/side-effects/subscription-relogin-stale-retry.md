# Side-Effects Review — Subscription dashboard stale-retry correction

**Version / slug:** `subscription-relogin-stale-retry`
**Date:** `2026-09-14`
**Author:** `Echo`
**Second-pass reviewer:** `Archimedes`

## Summary of the change

The Subscriptions dashboard now reconciles durable assisted-relogin history against the current subscription-pool truth before rendering an action. A suggested or failed repair remains actionable only while the exact account×machine cell is currently `needs-reauth`; an in-flight repair remains visible until the controller closes it. If health changes between render and click, the dashboard converts the typed server conflict into a plain-language refresh instead of exposing an internal error. The two approval routes also consistently classify revalidation refusal as HTTP 409. The implementation touches `dashboard/subscriptions.js`, the assisted-relogin routes in `src/server/routes.ts`, and focused unit, integration, and E2E tests.

## Decision-point inventory

- `repairAppliesToCurrentState()` in `dashboard/subscriptions.js` — add — deterministically decides whether a durable repair episode still applies to current pool truth.
- Account-card and matrix action rendering — modify — suppresses stale suggested/failed actions for cells that no longer need authentication.
- Account-card and matrix click-race handling — modify — refreshes current truth after the server reports the account is already active.
- Assisted-relogin approval HTTP classification — modify — maps typed revalidation refusals to 409 conflicts rather than 500 errors.

---

## 1. Over-block

The main over-block risk is hiding a repair whose pool state is stale `active` even though authentication has actually failed. The existing candidate authority already requires the subscription-pool authority to say `needs-reauth`, and the server independently revalidates that fact at action time, so exposing a retry while current authority says Active would only offer an action guaranteed to be refused. In-flight states are deliberately retained even if the pool flips Active, preventing a legitimate running repair from disappearing before final verification.

Unknown or malformed peer repair states are hidden. This is intentional fail-closed behavior: an unknown state has no defined action contract and cannot safely authorize a repair.

## 2. Under-block

The change does not erase stale terminal episodes from the durable audit ledger, so an API client that ignores current pool state could still display them incorrectly. The first-party dashboard is corrected and the server remains the final admission authority. A separate future repair state could also require explicit addition to the known-state allowlist before it appears; this is a conservative compatibility cost rather than unsafe action exposure.

## 3. Level-of-abstraction fit

This is at the presentation/reconciliation layer that combined the two authoritative reads incorrectly. The repair ledger remains authoritative for repair lifecycle and audit history; the subscription pool remains authoritative for whether a new suggested/failed repair is presently applicable. The server-side orchestrator remains the action authority and revalidates at point of use. No parallel repair authority is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] This is a closed hard-invariant reconciliation, not a judgment heuristic.

The UI rule is enumerable: `suggested` and `failed` are actionable only when current pool truth is exactly `needs-reauth`; known in-flight states remain visible; unknown states fail closed. This does not infer user intent or interpret ambiguous prose. The actual repair action is still authorized and revalidated by the existing deterministic orchestrator. The change therefore does not give a brittle detector independent judgment authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals judgment point. The inputs are typed state-machine values owned by two existing authorities, and the precedence is a spec-defined invariant: current pool health governs new actionability while the repair ledger governs an already-running lifecycle.

## 5. Interactions

- **Shadowing:** the dashboard reconciliation runs after both pool and repair reads. It hides only terminal/suggested actions that the point-of-use server revalidation would reject.
- **Double-fire:** no new actuator or request is added. A user click still sends one existing repair request.
- **Races:** if the cell changes from `needs-reauth` to Active after render, the existing server revalidation wins. The client consumes the typed 409, refreshes both authorities, and removes the invalid action.
- **Feedback loops:** terminal repair rows remain durable and continue to appear in the repair API. Rendering no longer feeds them back into another invalid retry when the pool is Active.

## 6. External surfaces

The visible dashboard changes from a raw `retry-revalidation-refused:account-not-needs-reauth` failure and retry invitation to the current Active state. API callers now receive 409 consistently for both direct and mandate-scoped approval revalidation conflicts. No persistent schema, credentials, provider data, or external service contract changes. The existing dashboard/PIN and phone-complete action surface is retained.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action:** yes. A legitimately eligible `needs-reauth` cell still presents its repair control directly; a healthy Active cell leads with its health and no invalid action.
2. **Zero raw internals as primary content:** yes. The already-active race is translated to “This account is already active. Refreshing its status…” and then replaced by refreshed state; the internal refusal slug is not shown.
3. **Destructive actions de-emphasized:** yes. This change adds no destructive control and does not promote cancel/delete behavior.
4. **Plain language + phone width:** yes. Existing touch targets/layout are unchanged, and the new status copy is short, plain language that fits the existing responsive cell/card surfaces without adding horizontal content.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read.** Subscription cells come from `GET /subscription-pool?scope=pool`, and repair episodes come from `GET /subscription-relogin?scope=pool`; the dashboard joins the exact account and machine identifiers from those merged reads. Point-of-use actions continue through the existing machine-targeted mandate route and are revalidated on the target machine. Peer read failure remains explicit and does not cause local data to authorize a remote repair.

The change emits no user-facing notices, adds no durable state, and generates no URLs. Existing machine-local repair ledgers remain visible pool-wide through the proxied read and therefore do not strand the dashboard view when the topic is handled on another machine.

## 8. Rollback cost

Pure code rollback: revert the dashboard reconciliation and HTTP status mapping and ship a patch. No data migration or agent-state repair is required because durable repair episodes are neither mutated nor deleted. During rollback propagation, users could temporarily see the stale retry/raw conflict again, but no invalid server-side repair would be admitted because point-of-use revalidation remains intact.

## Conclusion

The review preserves the split between current-health authority and durable lifecycle history, keeps in-flight work visible, fails closed on unknown states, and makes the click race self-healing. The main compatibility tradeoff—new unknown repair states remain hidden until explicitly supported—is conservative and covered by boundary tests. The change is clear to ship through the normal release and live-browser verification gates.

## Second-pass review (if required)

**Reviewer:** Archimedes
**Independent read of the artifact: concur**

The reviewer found no remaining blocker after both account-card and matrix paths shared typed already-active handling, both approval routes returned 409 consistently, unknown states failed closed, and the focused race tests plus `git diff --check` passed.

## Evidence pointers

- `tests/unit/subscriptions-render.test.ts`
- `tests/integration/subscriptions-tab.test.ts`
- `tests/integration/subscription-relogin-routes.test.ts`
- `tests/e2e/subscriptions-tab-lifecycle.test.ts`
- Focused result: 127 tests passed across the four files.
- Independent reviewer: concurred with no remaining blockers.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
