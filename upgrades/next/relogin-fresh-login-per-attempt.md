# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Assisted subscription re-login could fail about one second after starting, before it ever opened the browser. At `cli-starting`, the repair runtime adopted any existing non-terminal pending login for the account. For an **expired** one it called `enrollment.refresh()`, which bumps the login's lifetime `reissueCount`. The orchestrator then recorded that count as the episode's own reissue budget (`recordArtifactReissues`) and failed with `attempt-budget-exhausted` / `artifact-reissue-budget-exhausted` whenever it exceeded `maxReissues` (default 2). A dashboard login the auto-reissuer had been refreshing for days carries a count far above 2, so the repair could never get past its first step.

`SubscriptionReloginRuntime.startOrRecoverLogin` now abandons any non-terminal login it finds while the episode is in `cli-starting` and starts a fresh one (reissueCount 0). Each attempt owns its login. Nothing has been driven at that point, so replacing the login is safe. The later `artifact-ready` step still re-observes the attempt's own login, so an attempt's own reissues keep counting against its budget exactly as before. Admission is unchanged: a live `pending` login still refuses a repair (`pending-login-already-live`), so an operator's in-progress manual sign-in is never replaced.

No config, route or on-disk format changes.

## What to Tell Your User

Automatic sign-in repair had a bug that made it give up immediately when an old sign-in link was lying around for that account. It mistook the old link's refresh history for its own failed attempts. It now starts each repair with a fresh link, so an expired account actually gets repaired instead of being marked "gave up" within a second.

## Summary of New Capabilities

- Assisted re-login no longer fails instantly on accounts with a long-lived expired dashboard sign-in link. Each repair attempt starts its own fresh login.

## Evidence

- Live incident: episode `4ad1e073` (`sagemind-adriana`, Mac Studio, 2026-09-21) went `cli-starting → failed` in 1.1 s with `artifact-reissue-budget-exhausted`, `reissueCount 17`, and no browser drive. The fleet ledger shows 0 successful automated repairs.
- Test: `tests/integration/subscription-relogin-runtime.test.ts` "replaces a long-lived dashboard login at attempt start…" adopts an expired login with reissueCount 17. It fails against the pre-fix code (`expected 'failed' to be 'succeeded'`) and passes with the fix. It asserts no refresh, one abandon, one fresh start, the browser opening the fresh URL, and episode reissueCount 0.
- All 17 relogin test files (126 tests) pass, and `tsc --noEmit` is clean.
