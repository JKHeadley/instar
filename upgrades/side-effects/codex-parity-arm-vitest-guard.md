# Side-Effects Review: P0 arming — VITEST guard + skip-not-error on no-binary (CI fix)

## Change
Two corrections to the P0 arming wiring (init.ts + PostUpdateMigrator.ts), surfaced by CI:
1. The migration-time "no codex binary" case now goes to `result.skipped` (informational),
   NOT `result.errors` — it's expected on hosts/CI without codex, not a failure. (Fixes
   PostUpdateMigrator-codexHooks.test.ts which asserts `result.errors === []`.)
2. The arming SPAWN is gated on `!process.env.VITEST` in both init + migrate — never spawn a
   real codex TUI under the test runner (it's a slow side-effect; armCodexHooks is unit-tested
   directly + live-proven separately).

## Why
CI shards 1/2 failed: the migrateHooks test asserts no errors, but the wiring pushed a "no codex
binary" entry to result.errors. And on hosts WITH codex (e.g. a dev's asdf install), the test
would have spawned a real codex TUI mid-test — a bad side-effect. The VITEST guard makes the
migration/init arming deterministic + side-effect-free under test, while preserving production
behavior (arms on real updates/init when codex resolves).

## Scope / blast radius
- Test/CI: arming fully skipped (VITEST). Production: unchanged (arms, fail-soft, opt-out).
- No-binary is now a skip, not an error — cleaner result surfacing.

## Rollback
- Revert the two guards.

## Tests
- PostUpdateMigrator-codexHooks.test.ts 3/3 green; tsc clean. armCodexHooks logic still covered
  by its own 7 tests + the end-to-end live-proof.

## Publish
- PR #384 (codex-parity-merge → JKHeadley/main).
