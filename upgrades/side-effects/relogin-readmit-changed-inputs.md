# Side-Effects Review — assisted re-login re-admits an incident when its admitted inputs change

**Version / slug:** `relogin-readmit-changed-inputs`
**Date:** `2026-09-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (recovery-path change) — see below`

## Summary of the change

`src/core/SubscriptionReloginStore.ts` `suggest()`: when the source incident already has a row and a fresh admission's `inputDigest` differs from the row's, and the row is `suggested`, `cancelled` or a non-security `failed`, the row is reset to `suggested` under the new inputs and mode. Budgets, timestamps and failure class are cleared, a `candidate-readmitted-inputs-changed` event is recorded, and the row's notifications are reset. Before this, the incident was permanently stuck: approve and retry both re-check the stored digest, and `suggest()` returned the old row unchanged. Tests: `tests/unit/subscription-relogin-store.test.ts` (+4).

## Decision-point inventory

- `SubscriptionReloginStore.suggest` — modify — a stale episode for an open incident can be superseded by a new admission when the admitted inputs changed.
- Admission (`evaluateSubscriptionReloginAdmission`, including the breaker and `pending-login-already-live`) — pass-through. A candidate reaches `suggest` only if admission passes.
- Unattended auto-approval in `SubscriptionReloginService.tick` — pass-through. It acts on the re-admitted `suggested` row exactly as on a new one.

## 1. Over-block

No block surface added.

## 2. Under-block / new permissiveness

The change deliberately allows a fresh attempt after cancel or failure when inputs change. Guards:
- **Unchanged inputs:** a deliberate cancel stays cancelled, and a failure still needs an operator retry.
- **Security verdicts:** `refused` rows, and `failed` rows whose failure class is a breaker security class (`wrong-identity`, `unexpected-origin`, `permission-expansion`, `captcha`, `phone-confirmation`), are never re-admitted. This keeps breaker evidence intact.
- **Live repairs:** re-admission never takes the cell from another live repair (`live-repair-already-owns-cell`).

Residual: re-admitting an ordinary `failed` row removes it from the 3-failures-in-24h breaker count. The existing `retryFailed` path has the same property. Every re-admission needs a real input change, and each new failure is counted again. Most input changes are operator- or config-driven. `mode` also depends on unattended graduation evidence, so the retention prune or the cap removing old successes can flip it. That is at most one re-admission per flip.

## 3. Level-of-abstraction fit

The store owns episode identity and the one-row-per-incident invariant, so the fix lives there. Re-admission still flows through the unchanged admission policy, so no policy logic is duplicated.

## 4. Signal vs authority compliance

No new authority. Approval authority is unchanged: operator PIN, or the unattended allowlist evaluated by admission. The digest-bound approval safety holds, because a re-admitted row carries the new digest, and approval re-validates against it.

## 4b. Judgment-point check

No heuristic. The rule keys on structural facts: a digest change and a closed set of terminal states.

## 5. Interactions

- **Notifications:** the prior outcome's rows are deleted so the new suggestion and outcome are not suppressed by the `(episode, kind)` uniqueness. The event log keeps the full history. An approval-mode re-admission re-notifies the operator once.
- **Evidence:** `getUnattendedEvidence` counts `succeeded` rows, and those are never re-admitted.
- **Undelivered prior notices:** a prior outcome's notice that was still pending is dropped on re-admission, which is superseded by the new suggestion. A notice mid-delivery (`state='delivering'`) is left in place so its completion still finds its claim.
- **Flapping digest:** the digest covers stable fields only (source incident, account, machine, framework, provider, identity hash, profile, mode, and the passkey entry for passkey logins). No time-varying field, so no churn.

## 6. External surfaces

At most one extra notification per re-admission, and one extra repair run when unattended. No routes, config or schema change.

## 6b. Operator-surface quality

Not applicable — no dashboard or approval-surface file changed.

## 7. Multi-machine posture

Machine-local by design. Repair rows and incidents are per machine.

## 8. Rollback cost

Revert the `suggest()` hunk, then patch release. Re-admitted rows are ordinary rows, so no migration is needed.

## Conclusion

This unsticks incidents that had become permanently unrepairable, without weakening digest-bound approval, security verdicts or the breaker's security evidence.

## Second-pass review (if required)

**Reviewer:** independent subagent
**Independent read of the artifact:** "Concur with the review." Two minor points were folded in. First, `mode` can flip on evidence pruning, noted in section 2. Second, deleting all of the row's notifications could strand an in-flight delivery's completion. The deletion now skips rows with `state='delivering'`, noted in section 5.

## Evidence pointers

- Studio 2026-09-23: `justin-gmail` suggestion `2148d0a4` → `approval-input-digest-mismatch` after the account joined the unattended list. After the cancel, no new episode appeared for the still-open incident.
- The new tests fail pre-fix (3 of the 4; the security test holds either way), pass post-fix, and all 17 relogin test files are green.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (this modifies when a self-triggered repair may re-fire).
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/subscription-relogin-store.test.ts re-admission tests, howCaught: control-loop edge = re-admission only on an inputDigest change for an open incident; steady-state bound = one re-admission per distinct input change (the digest has no time-varying fields), each run still bounded by maxAttempts/wall-clock; settling brake = the unchanged per-account breaker, whose security evidence is preserved by never re-admitting security-class failures or refusals.}`
