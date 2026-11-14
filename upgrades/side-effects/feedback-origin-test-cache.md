# Side-Effects Review — confined feedback test cache

## Summary of the change

Tier 1, six test infrastructure files, a small path/configuration fix. Generated Telegram origin workers move from protected `node_modules/.cache` to ignored `.vitest`; Vitest configs honor `VITEST_CACHE_DIR` supplied by the confined runner. There is no shipped runtime `src/` change. Spec review rounds: 0. One original commit passed the gate; this revision records the independent second-pass review.

## Decision-point inventory

No new decision point. The existing sandbox keeps its authority over writable paths. This change directs test output to an already permitted location.

## 1. Over-block

No new rejection is added. Tests with native imports still resolve them through the repository's ancestor `node_modules`; a sandbox smoke checked that resolution.

## 2. Under-block

Other tests may still write temporary output under protected dependencies or under the agent home. This fixes only the two paths reproduced by the SecretStore worker. The sandbox continues to refuse such writes and must not be weakened to mask them.

## 3. Level-of-abstraction fit

The helper owns its generated worker path, and the Vitest configurations own Vitest's cache path. The confined runner already supplies `VITEST_CACHE_DIR`; making the configs use it repairs the missing connection at the correct layer.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, this adds neither a detector nor a blocking authority. The existing sandbox remains the sole authority over filesystem writes. A failed test remains a failed signal to the trusted executor gate.

## 4b. Judgment-point check

No model judgment or operator decision is replaced. Exact-head verification and independent review remain required for a feedback fix.

## 5. Interactions

The helper output stays in a gitignored directory, so it will not enter a proposed change set. The environment setting is used only when present. The push config keeps its explicit `INSTAR_VITEST_CACHE_DIR` priority and uses the confined setting as a fallback. Random per-worker directories avoid name collisions.

## 6. External surfaces

Developer and CI test output may move when they intentionally set `VITEST_CACHE_DIR`. No API, user message, or production secret path changes. A confined worker can now run affected tests without a dependency-cache write exception.

## 6b. Operator-surface quality

No operator-facing surface changes. The PR and release note explain the test failure in plain terms.

## 7. Multi-machine posture

Machine-local by design: generated test caches are disposable per checkout and per machine. No durable state, user-facing notice, or URL is produced. Feedback state and merge authority remain in their existing shared records.

## 8. Rollback cost

Revert these test-only paths in a patch release. Ignored cache files may remain until normal workspace cleanup; they do not affect persistent agent state.

## Conclusion

The existing sandbox boundary stays intact. Focused normal tests, a production-sandbox replay, and all three exact-head local test tiers passed on the original code head. The revised review-record head requires fresh exact-head verification before merge.

## Second-pass review

**Reviewer:** feedback_test_harness_review

A separate reviewer examined the PR at `27cc61c4f6bcb3ae0ede96269a8322bb7a6b7856` and concurred with no blocking issue. The reviewer checked all five Vitest configurations, the writable ignored worker directory, native dependency resolution, retained sandbox denials, and change-set exclusion. The reviewer read the prior focused sandbox evidence but did not rerun the full suites. This review is recorded in the fresh commit trace; the earlier trace incorrectly said second pass was not required.

## Evidence pointers

- Three Telegram origin unit files: 25 passed normally before the cache-config change; the same focused run exited zero under `SandboxRuntimeRunner` after the full patch.
- `npm run build`, `npm run lint`, and full `npm test`: 3,099 unit files passed, 56,500 tests passed, zero failures.
- The old worker log showed `EPERM` for both `node_modules/.cache` and `node_modules/.vite`.
- Exact-head local verification on the original code head passed build, lint, unit, integration, and E2E with zero failures at 2026-11-04T02:31:21Z. It flagged the absent second-pass trace; this amendment fixes that record and will be reverified.
