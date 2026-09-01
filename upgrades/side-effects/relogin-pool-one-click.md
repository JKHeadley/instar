# Side-Effects Review — one-click fleet re-login

**Version / slug:** `relogin-pool-one-click`
**Date:** `2026-08-29`
**Author:** Echo
**Second-pass reviewer:** `/root/relogin_side_effects_review`
**ELI16:** `upgrades/relogin-pool-one-click.eli16.md`

## Summary of the change

Closes the fleet seam in assisted re-login. The central dashboard reads machine-tagged episodes, renders the state-appropriate action on the exact account×machine cell, and converts one recent dashboard unlock into an exact, signed re-mint mandate. The target machine re-verifies the account, machine, episode, input digest, and requested approve/retry/cancel action at point of use.

## Decision-point inventory

- Pool episode aggregation — add — read-only, bounded peer fan-out with typed failures.
- Fronting repair authorization — add — recent operator-session proof plus exact account, machine, and episode.
- Target execution — add — local or asymmetrically verified delivered mandate must match account, target machine, episode, input digest, and action.

## 1. Over-block

An unreachable peer, expired dashboard session, missing mesh-delivery seam, stale episode, or mismatched identity refuses the click. The operator can retry after reachability or dashboard unlock is restored; no account state is changed by the refusal.

## 2. Under-block

Bearer-only callers cannot use the fronting route. The target does not trust the fronting request alone: it re-evaluates a local mandate or re-verifies the delivered asymmetric mandate and exact bounds. Residual risk is compromise of the trusted operator machine or its signing key, already inside the coordination-mandate threat boundary.

## 3. Level-of-abstraction fit

The dashboard selects no identity and grants no authority. It carries server-issued episode/account/machine identifiers. Deterministic route gates bind recent human proof to the existing signed re-mint authority; provider decisions remain inside the existing bounded repair worker.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle signal becomes authority.

Peer episode rows are status signals. Recent dashboard proof plus an exact signed mandate is the authority. The target's independent point-of-use verification remains the final gate.

## 4b. Judgment-point check

No semantic judgment is added. Account id, machine id, episode id, signature validity, expiry, and mandate bounds are enumerable invariants.

## 5. Interactions

- **Shadowing:** remote episodes are filtered out of machine-local account cards and rendered only on their exact matrix cells.
- **Double-fire:** the durable episode state rejects an action once it is no longer valid; mandates are exact, action-bound, and expire after one hour.
- **Races:** peer disappearance yields a typed retryable failure. Target state is re-read before approval.
- **Feedback loops:** the route starts one existing bounded repair episode; it creates no new poller or retry loop.

## 6. External surfaces

`GET /subscription-relogin?scope=pool` adds machine-tagged rows, typed truth failures, and separately typed feature-dark machines. `POST /subscription-relogin/repair-cell` is the dashboard entry point. `approve-with-mandate` is target-local service plumbing. The visible action is **Repair sign-in**, **Try repair again**, or **Cancel repair** according to durable state. A peer truth failure suppresses unsafe competing flows; an explicitly feature-dark target and a safely refused episode retain the manual sign-in fallback.

## 6b. Operator-surface quality

The primary action is one plain-language button on the exact cell. It exposes no paths, hashes, mandates, tokens, or JSON and requires no host access. A stale dashboard unlock produces one direct instruction to unlock and tap again.

## 7. Multi-machine posture

Status is aggregated, authority is delivered, but execution and credentials remain target-local. The fronting machine never receives provider secrets or browser state. The target accepts episode-bound mandates under the assisted-relogin rollout gate (independent of generic Account Follow-Me) and only when signed by its registered operator machine and pinned to itself.

## 8. Rollback cost

Pure route/dashboard change. Revert and publish; no migration or data repair. Existing local assisted repair and the older manual sign-in path remain intact.

## Conclusion

The change closes the phone-to-target seam without broadening ordinary API authority or moving credential state across machines. Ship requires focused three-tier evidence, independent review concurrence, full CI, deployment, and the two real canaries.

## Second-pass review (required)

The reviewer found three material gaps on the first pass: manual fallback was incorrectly suppressed for explicitly feature-dark machines, failed/waiting episodes had no recovery actions, and cross-machine delivery depended on the generic Account Follow-Me rollout gate. The implementation now separates `failed` from `unavailable`, exposes signed approve/retry/cancel actions, restores safe manual fallback after refusal or feature-dark status, and accepts only fully episode-bound mandates under the assisted-relogin gate. A later pass found and closed cross-surface authority bleed: repair-only mandates are refused by generic Account Follow-Me enrollment. The post-rebase pass then found that repair mandates were issued for an hour and not consumed. The correction clamps them to 15 minutes, rejects expiry at delivery and use, revokes local mandates before action, and durably tombstones delivered mandates before action so replay or redelivery cannot revive them. Replay, redelivery, and expiry regressions are test-pinned. The independent post-fix re-review concurred: exact bounds remain ahead of consumption, the two-server replay test passes, and no release blocker remains.

## Evidence pointers

- `tests/integration/subscription-relogin-routes.test.ts`
- `tests/integration/subscriptions-tab.test.ts`
- `tests/unit/subscriptions-render.test.ts`
- `tests/unit/account-follow-me-mandate-delivery.test.ts`
- `tests/e2e/subscription-relogin-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

**Defect class:** `unbounded-self-action`
**Closure:** `n/a`
**Reason:** this adds a one-shot operator-triggered dispatch into the already-registered, already-bounded subscription re-login controller; it adds no self-triggered loop.
