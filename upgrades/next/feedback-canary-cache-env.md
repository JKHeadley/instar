# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **The feedback executor's confinement rehearsal no longer fails on a cache location, which would have stopped the pipeline for a day.** `runRunnerCanary` ran every confined probe with `confinedEnv(process.env, { TMPDIR })`. vitest and esbuild write their caches next to the nearest package root, which from an attempt workspace resolves ABOVE the workspace into the agent home — a `denyRead` path — so the `base-unit-smoke` must-succeed probe died with `EPERM: operation not permitted, open '<agentHome>/package.json'`. Any canary probe failure calls `profileUnenforceable()`, which writes a `DAY_MS` latch that **no route can clear**, so a cache-location accident would have taken the executor offline for 24 hours. The canary env now also carries `VITEST_CACHE_DIR` and `ESBUILD_CACHE_DIR` under `paths.tmpDir`, exactly as `FeedbackExecutorService` already passes them to its own check runs. The sandbox settings are untouched: the agent home stays denied, and all 14 must-fail probes (including `bash-read-agent-config`, `bash-read-secret` and `bash-read-home`) are unchanged, so this cannot mask a real confinement break.

## What to Tell Your User

Nothing is user-visible and there is nothing to decide. If your agent runs the feedback factory, its sandbox rehearsal would have failed for a reason unrelated to safety and locked the pipeline for a day; it no longer does.

## Summary of New Capabilities

- No new surface. Two additional environment values inside `runRunnerCanary`.

## Evidence

- Measured in the real sandbox through `SandboxRuntimeRunner` with the canary's own settings, workspace = a trusted clone at current main with `node_modules` symlinked to the real deps cache: the smoke probe exits 1 with the agent-home `EPERM` as shipped, and exits 0 with the two cache dirs added. `git-status`, `git-diff` and `sqlite-open` exit 0 in the same run, isolating the failure to the cache location.
- `tests/unit/feedback-factory/execute-units.test.ts` gains an env-contract test asserting both cache paths resolve under the attempt temp for every probe; verified to FAIL with the pre-fix single-line env and pass with the fix (38 passed).
