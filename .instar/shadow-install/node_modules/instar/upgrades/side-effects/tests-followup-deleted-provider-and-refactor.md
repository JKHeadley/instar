# Side-effects review — Tests follow-up: deleted provider + helper refactor

**Version / slug:** `tests-followup-deleted-provider-and-refactor`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — tests-only update; no source behavior change.
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 2 — AnthropicIntelligenceProvider deletion + Phase 3a chokepoint relocation).

## Summary

Two CI-only test regressions surfaced after the bracket fix unblocked Type Check:

1. **`tests/unit/burn-detection-phase-1.test.ts`** — imported the deleted `AnthropicIntelligenceProvider` and exercised its Phase-1 wiring (attribution_key + rate-gate). Provider-portability v1.0.0 deleted that file per Rule 2; the new chokepoint is `src/providers/adapters/anthropic-headless/` which has its own dedicated test suite. The obsolete wiring tests are removed; the file's other sections (attributionKey, LlmRateGate, TokenLedger, lint-no-direct-llm-http) remain intact and continue to pass. The lint-allowlist test now points at the new chokepoint file (`anthropic-headless/transport/oneShotCompletion.ts`).

2. **`tests/unit/session-reap-detect.test.ts`** — asserted on inlined `'CLAUDECODE='` text inside `SessionManager.spawnSession`. The provider-portability refactor extracted that env-override into the `buildHeadlessLaunch` helper in `src/core/frameworkSessionLaunch.ts`. The assertion now checks both layers: SessionManager wires through `buildHeadlessLaunch`, and the helper sets `CLAUDECODE: ''` as an env override.

These are not pre-existing failures — they were caused by the v1.0.0 source-level changes and surface as test failures because the test files asserted on the prior shape. Per the "refactors break tests that assert on inlined content" memory, this is the expected follow-up shape.

## Decision-point inventory

- **Drop obsolete wiring tests** — `change`. The deleted provider has no replacement at the same abstraction level; the anthropic-headless adapter is tested in its own suite.
- **Update inlined-content assertion** — `change`. Match the new two-layer reality (caller wires through helper, helper sets env).

## Signal vs authority

CI Unit Tests are structural authority. Update unblocks the gate; no new gates introduced.

## Over-block / under-block analysis

**Over-block:** None.
**Under-block:** The attribution-wiring contract for the new chokepoint is covered by the anthropic-headless suite. Lint-allowlist coverage continues to assert the new chokepoint file is in the allowlist (was previously asserting the deleted file).

## Rollback cost

Zero behavioral risk. Reverting would re-introduce the same CI failures.

## Verification

- Local: `npx vitest run --shard=2/4 / 3/4 / 4/4` all green (196/196, 196/196, 193/193).
- CI re-runs all 8 shards on push.
