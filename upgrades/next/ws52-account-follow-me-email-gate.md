## What Changed

WS5.2 Account Follow-Me, §5.3/S7 — the **email-safety gate at enrollment completion**. When a follow-me enrollment completes on a machine, the freshly-minted account's real email (read from its config-home via the provider profile endpoint) is now validated against the email the operator approved BEFORE the account can be selected for any work. A surprise or mismatched email is HELD — the account is NOT added to the pool — and a HIGH attention item is raised for the operator. Threads `expectedEmail` from `EnrollmentWizard.start()` through `PendingLoginStore` to the new `EnrollmentWizard.completeFollowMe()`, and exposes it via a dark route `POST /subscription-pool/follow-me/enroll/:id/complete` that calls `SubscriptionPool.add()` only on a verified match. Fail-closed on every uncertainty (no oracle, unreadable email, missing expected email → held). Dark behind `multiMachine.accountFollowMe`; normal (non-follow-me) enrollment is completely untouched.

## Evidence

- 33 tests: 29 unit (`pending-login-store` expectedEmail threading; `enrollment-wizard` `completeFollowMe` — validated match, mismatch→held+attention, oracle-unavailable→held, oracle-throws→held, no-oracle→held, missing-expected-email→held, unknown→not-found) + 4 Tier-2 integration over the REAL HTTP pipeline (`account-follow-me-complete-route`: dark→503, validated→201+account added, mismatch→200 held+pool unchanged+HIGH attention, unknown→404). `tsc --noEmit` clean.
- Side-effects review + mandatory independent second-pass security review (concurred): traced every fail-closed path, confirmed `SubscriptionPool.add()` is reached ONLY on a verified email match, no regression to normal enrollment, deterministic attention-id de-dup, and the dark gate.
- Spec: `docs/specs/ws52-account-follow-me-security.md` §5.3/S7 (converged, approved).

## What to Tell Your User

Still nothing to do — this ships off by default as part of the multi-machine account-sharing groundwork. With it, when a machine enrolls one of your accounts, I verify the login that actually completed matches the account you approved BEFORE using it — if it doesn't (a typo, the wrong account, an unverifiable login), I hold it and flag you rather than ever using a surprise account. The one-tap enrollment surface that drives this end-to-end is the next step.

## Summary of New Capabilities

Email-identity safety gate at follow-me enrollment completion (dark): a freshly-enrolled account is validated against the operator-approved email before it becomes selectable; a mismatch is held (never auto-used) and raises a HIGH attention item. New dark route `POST /subscription-pool/follow-me/enroll/:id/complete`. No user-facing surface is live in this release.
