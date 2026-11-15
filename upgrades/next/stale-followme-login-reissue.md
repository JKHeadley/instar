# A sign-in that already worked is no longer re-asked forever

<!-- bump: patch -->

## What Changed

A follow-me pending login (one tied to an expected account email and a config-home slot) was re-driven on every expiry for as long as it stayed pending. The completion sweep closes such a login only when the slot's auth revision changes from a baseline, every reissue takes a new baseline, and on Linux no auth revision is readable at all. So a login whose sign-in had finished another way was renewed forever. On 2026-11-13 one on Mama PC had been renewed 1113 times in 11 days for an account that was active and reading quota.

`EnrollmentWizard.reissueExpired()` and `recoverAfterRestart()` now accept optional `AlreadySignedInDeps` (`accountIsHealthy`, local state only). With them, before re-driving a Claude follow-me login the wizard requires (1) that this machine's pool already holds the account `active`, as the expected email, with no identity drift, and (2) that the slot answers the identity oracle's live read (the read used for `proof: 'live-identity'`) as exactly that email. Then it completes only the stale login; the pool is not written. Codex logins, unhealthy or drifted accounts, a different account, an unreadable slot, a probe error, a login without an expected email, or a login that changed during the read all re-drive as before. The server passes the deps on both paths. `refresh()`, the reissue route and the completion sweep are unchanged.

## What to Tell Your User

If an account showed a sign-in request even though it was working, that request now clears by itself within a few minutes, and the agent stops starting a new sign-in for it every quarter hour. Nothing for you to do.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Stale follow-me sign-ins close themselves when the account already works | Automatic on the next reissue sweep or restart |

## Evidence

- Unit: `tests/unit/enrollment-wizard.test.ts`: healthy account + slot answers as expected → closed, no new code, no further reads; restart recovery closes it; unhealthy account → never read, re-driven; Codex → never read, re-driven; a different account, an unreadable slot, a throwing probe or no oracle → re-driven; no expected email → never read; no deps → unchanged; cancelled during the read → stays cancelled; account turns unhealthy during the read, or the health check throws → re-driven. Six tests (with the wiring file) fail on the old code.
- Wiring: `tests/unit/enrollment-already-signed-in-server-wiring.test.ts`.
- E2E: `tests/e2e/subscription-enrollment-lifecycle.test.ts`: after a restart the login is gone from `GET /subscription-pool/pending-logins` and durably completed.
