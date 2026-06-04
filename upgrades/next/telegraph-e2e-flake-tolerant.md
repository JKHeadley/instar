<!-- bump: patch -->

## What Changed

The Telegraph publishing end-to-end test (`tests/e2e/telegraph-publish.test.ts`)
makes real calls to the live Telegraph API, which occasionally returns transient
errors (`PAGE_SAVE_FAILED`, network blips, 5xx, rate-limit) through no fault of
ours. Because the suite runs in the standard CI lane (it only skips when
`SKIP_E2E=1`), one such hiccup failed the entire build on an unrelated PR — a
Gemini quota change (#756) that touches zero Telegraph code got a red build
purely because the Telegraph service blinked at the wrong moment.

This change adds a test-local `withTransientRetry` helper wrapping the six
live-API call sites (`ensureAccount` / `publishPage` / `editPage` /
`getPageViews`): a transient / network / 5xx / 429 error is retried up to 4× with
short backoff; a real failure — an assertion-worthy bug, or a persistent outage
after retries are exhausted — still fails immediately and loudly.

## Evidence

- **Reproduction:** Codey PR #756 (a Gemini quota-state change touching zero
  Telegraph code) got a red CI build when the live Telegraph API returned a
  transient `PAGE_SAVE_FAILED` during the Unit-Tests node-22 shard. Confirmed via
  `instar dev:ci-failures 756`:
  `✗ src/publishing/TelegraphService.ts:298 Telegraph API error: PAGE_SAVE_FAILED`
  surfacing at `tests/e2e/telegraph-publish.test.ts:102`.
- **Before:** any transient Telegraph hiccup failed the whole build on unrelated
  PRs — a false failure that blocks merges and sends people chasing a non-bug.
- **After:** the six live-API calls retry transient errors up to 4×; real
  failures still fail immediately. Verified locally: `tsc --noEmit` clean and all
  5 e2e tests pass against the live API
  (`npx vitest run tests/e2e/telegraph-publish.test.ts --config vitest.e2e.config.ts`
  → `Tests 5 passed (5)`).

## What to Tell Your User

Nothing user-facing — this is an internal CI-reliability fix. No shipped behavior
changes; agent-only.

## Summary of New Capabilities

None — internal test-suite robustness improvement (flaky external-API e2e no
longer fails CI on unrelated PRs).
