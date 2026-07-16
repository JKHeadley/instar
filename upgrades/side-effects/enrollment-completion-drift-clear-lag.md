# Side-effects review — enrollment completion drift-clear lag

## Change boundary

All three successful completion paths—plain completion, follow-me completion, and submit-code's validated completion—call one local helper after the credential has been committed. The helper invalidates only the completed login's config-home identity cache entry and polls only the matching pool account. Held, submitted, cancelled, not-found, and failed completions do not reverify.

## State and ordering

The durable enrollment transition happens first. Identity cache invalidation happens before the targeted poll, so pre-login evidence cannot close or preserve drift. The existing QuotaPoller reconciliation remains the sole writer of `identityDrifted`; this route does not duplicate that authority. No timer or background job is introduced.

## Failure direction

A missing pool account or unwired poller preserves existing completion behavior. A temporary targeted-poll failure is logged and leaves the successfully completed enrollment intact; the scheduled poll retries later using the already-invalidated cache. This is fail-toward-fresh-retry, not fail-toward stale identity.

## UI precedence

Only a fresh `just-verified` transient may outrank a stale `needs-reauth` cell. Pending-login liveness, held, cannot-resolve, expired, and offline states retain precedence. Active cells retain their established active state plus success highlight.

## Privacy, security, and multi-machine effects

No credential, token, URL, or code is returned or logged. The helper uses the server-owned completed login and pool account, never request-supplied identity. Reverification is target-local to the machine that completed enrollment; pool replication observes the resulting normal pool update. There is no fan-out or cross-machine write.

## 6b. Operator-surface quality

1. **Primary action first:** unchanged. The cell continues to lead with the setup/sign-in action when action is needed; after completion it leads with the terminal success state.
2. **Zero raw internals as primary content:** yes. The operator sees “Set up complete,” never cache, poller, drift flags, config homes, or account IDs.
3. **Destructive actions de-emphasized:** unchanged. This patch adds no destructive action and does not promote cancel, revoke, or removal controls.
4. **Plain language at phone width:** yes. It reuses the existing compact success label and cell ceremony, adding no new prose or layout that can overflow the matrix cell.

## Rollback and verification

Rollback is code-only and needs no data migration. Unit coverage locks render precedence, integration coverage locks invalidation-before-targeted-poll, and real-server E2E proves completion clears simulated drift without a scheduled sweep.

## Second-pass review

Not required: this change invokes the existing identity-reconciliation authority after a user-completed login; it does not add or widen a gate, session lifecycle action, autonomous trigger, destructive operation, or trust decision.
