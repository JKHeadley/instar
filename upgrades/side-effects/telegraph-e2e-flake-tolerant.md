# Side-Effects Review — Telegraph e2e tolerant of transient external-API errors

**Version / slug:** `telegraph-e2e-flake-tolerant`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`tests/e2e/telegraph-publish.test.ts` makes REAL calls to the public Telegraph
API. That API intermittently returns transient errors (`PAGE_SAVE_FAILED`,
network blips, 5xx, rate-limit) under no fault of ours. Because the suite runs
in the standard CI lane (it only skips when `SKIP_E2E=1`), a transient hiccup
fails the whole build on UNRELATED PRs — it just failed the Unit-Tests shard on
Codey PR #756 (a Gemini quota change touching zero Telegraph code).

The fix adds a test-local `withTransientRetry(label, fn)` helper and wraps the
six live-API call sites (`ensureAccount` ×2, `publishPage` ×2, `editPage`,
`getPageViews`). On a transient/network error it retries up to 4× with linear
backoff; a non-transient error (real bug / assertion-worthy failure) throws
immediately; if all retries are exhausted it throws (genuinely-down → fail).

## Decision-point inventory

One decision point: `withTransientRetry` classifies a caught error as transient
(via the `TRANSIENT_API_ERROR` regex) or not. Transient → retry/eventually-fail;
non-transient → rethrow immediately.

## 1. Over-block

**What legitimate failures does this now hide?** None that matter. The regex
matches only transient external-service signatures (`PAGE_SAVE_FAILED`,
`ENOTFOUND`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`, `socket hang up`,
`fetch failed`, 5xx, 429). Assertion failures (`expect(...)`) are NOT thrown by
the wrapped service calls, so real test-logic regressions still fail. A genuine
persistent API outage still fails the test after the retries are exhausted.

## 2. Under-block

**What does it still catch?** Any non-transient error from the service (bad
auth, a real TelegraphService bug, a 4xx other than 429) rethrows on the first
attempt — no masking. The retry is scoped to the e2e file only; no production
code path retries (so the publish-idempotency concern — a retry creating a
duplicate page — is irrelevant: duplicate test pages are harmless, Telegraph
pages are free + don't expire, and the assertions check `>= 1`, not an exact
count).

## 3. Blast radius

Test-only: one file, `tests/e2e/telegraph-publish.test.ts`. No `src/` change, no
production behavior change, no API/schema/config change. The helper is local to
the file (not exported / not shared).

## 4. Reversibility

Fully reversible: revert the one file. No state, no migration, no persisted
format. Verified locally: `tsc --noEmit` clean and all 5 e2e tests pass against
the live API.
