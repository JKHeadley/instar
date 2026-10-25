# Side-Effects Review — assisted subscription re-login

**Version / slug:** `assisted-subscription-relogin`
**Date:** `2026-08-28`
**Author:** Echo
**Second-pass reviewer:** `/root/relogin_side_effects_review`

## Summary of the change

Adds an approval-gated, restart-safe Claude Code sign-in repair controller plus a phone-complete dedicated Google-profile provisioning surface. It composes the subscription pool, passive sign-in ledger, enrollment wizard, Playwright profile registry/seat lease, identity oracle, credential-location authority, quota probe, dashboard PIN proof, credential write/readiness funnels, and attention hub. It adds local repair state, browser/CLI orchestration, dashboard/routes, migration/awareness, privacy exclusions, and three-tier proof.

## Decision-point inventory

- Candidate admission — add — ready pool authority, corroborated incident, exact account/machine/profile identity, supported method, and closed breaker.
- Episode approval — add — short-lived proof minted by recent dashboard PIN unlock; ordinary bearer access is insufficient.
- Profile provisioning — add — recent PIN proof creates one Google identity/profile tuple and jailed 0700 directory; no secret value is accepted.
- Browser action selection — add — exact origin/identity/scope/challenge floors plus a constrained Tier-1 classifier selecting from a closed action set.
- Retry/cancellation — add — typed transient retries within bounds; security outcomes never retry; cancellation prevents further actions.
- Success — add — independent identity, authenticated-use, correct-slot, active-pool, and exact-incident-closure witnesses.
- Rollout — add — fleet disabled/dry-run by default; approval mode first; unattended dark.

## 1. Over-block

Legitimate flows are refused for account choosers, aliases without canonical proof, managed ambiguity, unfamiliar UI, added consent, CAPTCHA, phone/risk confirmation, or absent profile directories. A benign provider change can therefore require intervention. Provisioning rejects the default profile, stale/missing operator proof, invalid profile names, paths outside the agent home, and unknown vault names.

## 2. Under-block

Residual risk is provider UI/policy drift that still matches existing predicates, plus host compromise. Exact-origin/scope checks, closed supervisor I/O, wrong-identity proof, security breakers, disposable canary, and fleet-dark rollout bound but cannot eliminate third-party drift. Host filesystem compromise is outside this feature's security claim.

## 3. Level-of-abstraction fit

Admission, approval, path-jail, identity, scope, budgets, and success rules are deterministic authorities over enumerable invariants. Page observations are signals; they do not authorize clicks. The constrained classifier is the single action selector within hard floors. Provisioning reuses the registry and vault-name validator rather than creating parallel account, credential, or path authorities. Repair state cannot redefine pool/ledger status.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No brittle semantic detector owns judgment authority.
- [x] Deterministic blockers are structural/security invariants over an enumerable domain.
- [x] The browser classifier is context-rich but constrained by hard floors and a closed action set.

DOM/page detectors produce typed observations. They cannot bypass the bounded action authority or declare success. Blocking rules cover structural validity, exact identity/origin/scope, operator proof, physical locality, and irreversible credential safety—the explicit invariant/safety exceptions in the referenced principle.

## 4b. Judgment-point check

No static heuristic arbitrates competing work/liveness/ownership signals. Admission and approval are closed invariants; browser selection uses the constrained supervisor inside hard floors. Retry eligibility is enumerated by typed failure class and durable budgets.

## 5. Interactions

- **Shadowing:** admission runs after passive-ledger and pool authorities; absent/corrupt/ambiguous upstream state refuses visibly.
- **Double-fire:** one episode per cell, CAS transitions, immutable digest, single-use proof, seat lease, and stable delivery key prevent duplicates.
- **Races:** restart recovery re-reads authority; uncertain browser outcomes park operator-only. Cancellation persists before aborting; later stages recheck version/state.
- **Feedback loops:** finalization changes pool/source incident only after proof; the next scan has no eligible incident.
- **Provisioning:** the compound route reuses exact rows, materializes only a jailed directory, and uses registry CAS. A failure can leave an empty visible profile/directory, never a secret or hidden authority; retry repairs it.

## 6. External surfaces

The dashboard gains **Repair sign-in** and **Create a dedicated sign-in profile**. API clients gain bounded episode/actions and the PIN-scoped compound profile route. The worker may navigate exact provider origins, submit existing vault-held credentials, accept only the requested Claude scope, paste into the exact pane, and finalize after proof. It cannot change password, recovery email, MFA, billing, plan, or scope. Notices are bounded through the existing hub.

Every human action is phone-complete: dashboard unlock, provider link, Secret Drop link, or dashboard challenge response. Host or remote-desktop access is not required.

## 6b. Operator-surface quality

1. **Leads with the primary action:** yes—Google identity, friendly profile name, sign-in method, and one 44px primary button are open on arrival.
2. **Zero raw internals as primary content:** yes—no UUIDs, hashes, paths, enums, or JSON are headline content.
3. **Destructive actions de-emphasized:** yes—this surface has no delete/revoke action; repair cancellation is secondary.
4. **Plain language + phone width:** yes—full-width 44px controls, 16px inputs, readable copy, and no horizontal-scroll dependency.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** CLI pane, config home, credential, browser seat, cookies, and user-data directory are physical truths of one machine. Peers may proxy bounded status but cannot replay a credential-bearing episode or materialize on the wrong host. State does not replicate. Topic transfer does not transfer active repair ownership; it remains visible through the holder. Notices use existing one-voice routing. Provider/Secret Drop/dashboard URLs use public tunnel surfaces; localhost links are never user-facing.

## 8. Rollback cost

- **Kill switch:** set relogin `enabled:false`/`dryRun:true`.
- **Hot fix:** revert and publish a patch.
- **Data migration:** none; metadata-only SQLite/registry state may remain unread and fields are add-missing.
- **Agent repair:** no credential reset. Empty dedicated directories may remain or later be removed through guarded management.
- **User visibility:** actions disappear/report disabled while rollback propagates; existing credentials/pool remain intact.

## Conclusion

Review tightened provisioning from API-only metadata into a recent-PIN, phone-complete materialization flow and made the no-host-access boundary explicit. No brittle semantic detector owns authority; secret values remain outside prompts, APIs, persistence, logs, and screenshots. Ship requires independent concurrence, refreshed full suite, CI, publish/deploy, and disposable live canary.

## Second-pass review (required)

**Reviewer:** `/root/relogin_side_effects_review`
**Independent read of the artifact:** concur

Concur with the review. Deterministic invariants own admission, approval scope,
identity/origin/scope floors, retries, cancellation, and success; the constrained
supervisor only selects from an already-authorized closed action set. CAS,
single-flight execution, abort propagation, restart re-observation, and
operator-only parking handle races conservatively. PIN-scoped profile provisioning,
machine-local privacy boundaries, phone-complete intervention, and kill-switch
rollback are complete; no ship-blocking concern was found.

## Evidence pointers

- Profile/dashboard extension: 165 focused tests passed.
- Final authoritative three-tier gate after the extension: 50,265 unit + 4,061 integration + 3,110 E2E = 57,436 tests passed, zero failures.
- Build and static preflight passed. CI/deployment/disposable live-canary evidence remains release-blocking.
- CI portability repair: Chrome discovery now covers macOS and Linux paths; the real-process integration runs when Chrome exists and explicitly skips on browserless runners instead of treating CI inventory as a product failure.

## Class-Closure Declaration (display-only mirror)

**Defect class:** `unbounded-self-action`
**Closure:** `guard`
**Enforcement:** ratchet
**Citation:** `tests/unit/self-action-convergence.test.ts`

This adds bounded self-triggered repair/recovery. `tests/unit/self-action-convergence.test.ts` guards the convergence argument: one episode per cell, max 3 attempts, max 2 reissues, 10-minute wall clock, capped backoff, stable delivery key, durable breaker, cancellation, and operator-only parking for uncertain non-idempotent outcomes. The loop settles at success, refusal, cancellation, failure, or operator-only; terminal states never self-reopen.
