# Side-Effects Review — assisted re-login starts each attempt with a fresh login

**Version / slug:** `relogin-fresh-login-per-attempt`
**Date:** `2026-09-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (recovery-path change) — see below`

## Summary of the change

`src/core/SubscriptionReloginRuntime.ts` `startOrRecoverLogin`: while the episode is in `cli-starting`, any non-terminal pending login for the account (`pending`/`expired`) is abandoned via `EnrollmentWizard.abandon` and a fresh login is started. Previously, an expired login was adopted and `refresh()`ed, and its lifetime `reissueCount` was then recorded as the episode's reissue budget. The orchestrator failed the episode (`artifact-reissue-budget-exhausted`) whenever that count exceeded `maxReissues`, before any browser drive. Test: `tests/integration/subscription-relogin-runtime.test.ts` (+1).

## Decision-point inventory

- `SubscriptionReloginOrchestrator` reissue-budget check — pass-through (unchanged). It now sees only the attempt's own reissues.
- `evaluateSubscriptionReloginAdmission` `pending-login-already-live` — pass-through (unchanged). A live `pending` login refuses admission, but only at admission time. After admission, the abandon branch can also retire a manual login the operator starts between approval and the attempt's first tick, as well as `expired` logins and the attempt's own login after a retry re-enters `cli-starting`.

---

## 1. Over-block

No block/allow surface added. The change removes a false failure.

## 1b. Out-of-band completion (second-pass concern, accepted with reasoning)

A device-code (Codex) sign-in can succeed in the browser without instar being told. `EnrollmentWizard.reissueLogins` consults a credential witness before killing such a pane. The new abandon branch does not. If an expired device-code login was actually approved out of band, the repair abandons it and drives a fresh login for the **same** account in the **same** slot. The cost is one redundant approval. It is identity-verified (`verifyIdentity`) and wrong-account-quarantined like any repair, and it replaces the slot's credential with an equally valid one for the same identity. Nothing is lost that the repair doesn't immediately re-establish, and no identity or authority changes. Adopting a completed login instead would need a new orchestrator path from `cli-starting` straight to `identity-verifying`. That is a larger state-machine change, and a live incident doesn't justify it. One residual cost: in unattended mode, that redundant drive can meet a CAPTCHA or phone check, which parks the episode at `waiting-operator-only` even though the slot's credential was already fine. That is a spurious ask, never a wrong credential. For url-code-paste (Claude), the only kind implicated in the observed failure, the witness doesn't apply (`completedWithoutTelling` returns false for non-device-code).

## 2. Under-block

The per-attempt budget can no longer be tripped by history from earlier attempts. Across attempts, the episode's recorded `reissueCount` is a high-water mark (`recordReissue` only raises it). Separately, the repair is bounded by `maxAttempts` (≤5), the 10-minute wall clock and the per-account breaker. A login that is re-issued repeatedly within one attempt still trips the budget as before. Remaining gap, out of scope here: a dashboard link kept perpetually `pending` by the auto-reissuer refuses admission indefinitely (`pending-login-already-live`). This change does not touch that. It is recorded as its own follow-up. <!-- tracked: topic 33890 -->

## 3. Level-of-abstraction fit

The runtime adapter owns the login artifact lifecycle (`startOrRecoverLogin` is the port whose contract is "re-observe an existing pending attempt"). The fix sits there and does not bend the generic orchestrator's budget logic. The orchestrator stays deterministic and provider-agnostic.

## 4. Signal vs authority compliance

No new authority. The existing repair authority (operator-approved or allowlisted unattended episode) is what abandons and starts the login. Only the artifact's provenance changes.

## 4b. Judgment-point check

No heuristic added at a competing-signals decision point. The branch keys on a structural state (`episode.state === 'cli-starting'` plus the login's non-terminal status).

## 5. Interactions

- Dashboard pending-logins panel: an expired link for the account is marked `abandoned` when a repair starts. The operator sees the repair's fresh attempt instead, which is intended.
- Tmux sign-in pane: `EnrollmentWizard.start` pre-cleans a stale pane for the same account id. That is the same abandon-then-start sequence `/subscription-pool/follow-me/enroll/start` already uses for a dead-pane supersede.
- Restart during `cli-starting`: a re-run replaces the login again. Nothing was driven yet, so no external effect is lost. The approval is episode-scoped, so no re-approval is needed.
- Unattended and approval modes behave identically.

## 6. External surfaces

At most one extra `claude auth login` / `codex login` start per attempt. That is provider-visible but equivalent to a user retrying sign-in. No new routes or config.

## 6b. Operator-surface quality

Not applicable — no dashboard or approval-surface file changed.

## 7. Multi-machine posture

Machine-local by design. Each machine repairs its own login slot with its own pending-login store. Nothing replicates.

## 8. Rollback cost

Revert the single hunk in `SubscriptionReloginRuntime.ts`, then patch release. No state migration. Abandoned login records are ordinary terminal rows.

## Conclusion

Safe, narrowly scoped bug fix that unblocks the assisted re-login feature's first real step.

## Second-pass review (if required)

**Reviewer:** independent subagent
**Independent read of the artifact:** First pass: concern raised. The abandon skips the device-code completion witness, and the admission claim overstated its coverage. Both are addressed in 1b and the decision-point inventory. Second pass: "Concur with the review." The residual CAPTCHA/phone-check cost the reviewer noted is added to 1b.

## Evidence pointers

- Episode `4ad1e073-ed01-4352-b8ca-9ed44fc91850` events: `cli-starting` → `artifact-reissued` → `failed/artifact-reissue-budget-exhausted` within 1.1 s, `reissueCount 17`.
- Regression test fails pre-fix (`expected 'failed' to be 'succeeded'`), passes post-fix. The full relogin suite (126 tests) is green.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action` (this modifies a self-triggered recovery path that starts a login on its own).
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/integration/subscription-relogin-runtime.test.ts "replaces a long-lived dashboard login…", howCaught: control-loop edge = one abandon + one start per attempt entry into cli-starting; steady-state bound = at most maxAttempts (≤5) fresh logins per episode, within a 10-minute wall clock; settling brake = the existing per-account breaker plus terminal failure after maxAttempts. The test asserts exactly one abandon and one start for a successful episode.}`
