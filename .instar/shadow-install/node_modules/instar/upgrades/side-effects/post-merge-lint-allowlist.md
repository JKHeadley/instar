# Side-effects review — Post-merge lint allowlist + release-guide cleanup

**Version / slug:** `post-merge-lint-allowlist`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — pure additive (allowlist expansion) + content fill (upgrade guide).
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Rule 2 — AnthropicIntelligenceProvider deletion).

## Summary

Three post-merge fixups needed before the v1.0.0 push can pass the pre-push gate:

1. **`scripts/lint-no-direct-llm-http.js` ALLOWLIST update.** Drops the deleted `src/core/AnthropicIntelligenceProvider.ts` entry; adds the seven `src/providers/adapters/anthropic-headless/*` files that are the LEGITIMATE Anthropic chokepoint in v1.0.0 (same role Phase 1 of the burn-detection spec envisioned for `AnthropicIntelligenceProvider`). Without this fix, the lint rule false-positives on every adapter API call.

2. **Remove `src/core/badNewCode.ts` and `src/core/exemptCode.ts`.** These were stray test fixtures created by a misconfigured `check-rule3-coverage.test.ts` run on this worktree. The test uses `mkdtempSync` for its real fixtures; these files in `src/core/` shouldn't exist on disk. They tripped the lint rule (intentional violation inside the fixture file).

3. **Fill in `upgrades/1.0.0.md` template placeholders.** "What to Tell Your User" gets four conversational bullets (per-topic framework swap, local model, upgrade safety, optional API-key warning). "Summary of New Capabilities" gets a five-row table. Removed HTML-comment scaffolding whose example text (`silentReject`, `maxRetries`) was tripping the camelCase config-key validator that runs at pre-push.

## Decision-point inventory

- **ALLOWLIST scope** — `extend`. The new entries are the anthropic-headless adapter's API touchpoints (authCredentialInjection, usageMeterProvider, oneShotCompletion, agenticSessionHeadless, errors, smoketest, fileSystemAccess). All are inside `src/providers/adapters/anthropic-headless/` and constitute the migrated Anthropic chokepoint.
- **AnthropicIntelligenceProvider removal from ALLOWLIST** — `change`. The file is deleted; allowlisting a non-existent file is dead config.
- **Stray fixture deletion** — `change`. These shouldn't have been on disk in the first place; the tests are unaffected.
- **Upgrade guide content** — `add`. Fills in template placeholders; conforms to the user-facing-language rules baked into the validator.

## Signal vs authority

The lint rule is structural authority (blocks the build). The release-guide validator is structural authority (blocks publish). Both are pre-push gates with clear escalation. No semantic change to either.

## Over-block / under-block analysis

**Over-block:** None new. Removing `AnthropicIntelligenceProvider.ts` from the allowlist doesn't change behavior — the file doesn't exist. Adding anthropic-headless entries restores the intent of the original ALLOWLIST after the v1.0.0 chokepoint migration.

**Under-block:** None. The anthropic-headless adapter IS the chokepoint per Phase 3a; allowing its API calls is exactly what the lint rule intends to permit.

## Rollback cost

Pure config change. Revert the script edit + delete the fixture-file deletion + revert the upgrade-guide content. Nothing depends on these for runtime behavior.

## Verification

- `node scripts/pre-push-gate.js` — warnings only, no errors.
- `node scripts/check-codex-rule1-drift.js` — clean.
- Manual: lint rule walks `src/` and produces no violations after the allowlist update.
