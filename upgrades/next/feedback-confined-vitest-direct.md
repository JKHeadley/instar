# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The feedback executor now runs its installed Vitest executable directly for its sandbox canary, before-and-after regression checks, and related tests. The canary version changes so updated agents rehearse the new command even if an older smoke had passed. In a live critical feedback attempt, the `npx` launcher remained idle without starting Vitest until the 20-minute command limit expired. The direct executable reached the same named test in 10 seconds under the same production sandbox policy. The executor still requires the original fail-before, pass-after, lint, related-test, independent-review, and exact-head merge gates.

## What to Tell Your User

Feedback fixes can move through their safety tests again when the package manager's test launcher stalls. The tests and review requirements are unchanged. A critical saved-secret fix is still waiting for a fresh worker attempt and has not been merged.

## Summary of New Capabilities

None. This repairs the feedback executor's test launch path.

## Evidence

The critical SecretStore attempt `feedback-e800bf35-6381-46e7-a769-1530c55ac7ac:a7` failed `limit:command-wall-clock` after an idle `npm exec vitest` process started no Vitest child. A production `SandboxRuntimeRunner` replay using the direct installed executable reached the expected old-code assertion failure in 10.3 seconds. Build, lint, the two focused executor unit files (155 tests), and the full unit suite (56,601 passed, zero failed) passed. Integration, E2E, exact-head verification, and CI results are required before merge.
