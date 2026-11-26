# The first CDP command after a Chrome spawn waits on the launch budget

Tier 1. One timeout value changes for one call, plus a test warm-up. Rollback is a revert.

- What changed. In passkey (pipe) mode, `openPipe` sends `Target.setAutoAttach` as the first message Chrome receives after spawn. That call now waits up to `launchTimeoutMs` instead of `operationTimeoutMs`. `send()` gained an optional per-call timeout that defaults to `operationTimeoutMs`, so every other call is unchanged. The passkey fixture test launches and closes one warm-up browser in `beforeAll`.
- Evidence. On instar CI, `tests/integration/passkey-browser-fixture.test.ts` failed with `cdp-timeout:Target.setAutoAttach` 13 times on Unit Tests shard 2 between 2026-11-19 and 2026-11-24, including main on 11-20 and 11-24. Every failure was the file's FIRST case, at 20.8-41.0s, while every later Chrome launch in the same file took 1.5-5.6s. The slow part was the first cold Chrome start in a loaded worker, and it was charged to the first `send()`.
- Over-block. None. No check is weakened and nothing new refuses anything.
- Under-block. A Chrome that never answers is now reported after `launchTimeoutMs` (default 10s, at most 30s) rather than `operationTimeoutMs` (default 10s, at most 30s). With defaults the two are equal. A caller that sets a short launch budget and a long operation budget gets a shorter wait for this one call, which matches what it asked for.
- Layer. The timeout belongs to the launch phase, so it uses the launch budget. The existing `chrome-launch-timeout` race on the attached-page promise is unchanged.
- Signal and authority. No change. This is transport timing only. The credential, origin-policy and removal paths are untouched.
- Test warm-up. A failed warm-up is swallowed on purpose. It is not a verdict, and every case launches its own browser and fails on its own if Chrome is broken. The warm-up's profile dir joins `dirs`, so the existing `afterEach` removes it.
- External surfaces and multi-machine posture. None. No persisted format, config or API change.
- Rollback. Revert the commit.

Verification: `npx vitest run -c vitest.integration.config.ts tests/integration/passkey-browser-fixture.test.ts` passed 11/11 against real headless Chrome (first case 789ms). The four unit files that import ChromeCdpReloginBrowser passed 50/50. `tsc --noEmit` exited 0. A loaded CI runner cannot be reproduced locally, so the CI shard history is the falsifier: the first case should stop failing with `cdp-timeout:Target.setAutoAttach`.
