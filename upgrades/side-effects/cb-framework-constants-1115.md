# Side-Effects Review — #3072: shared engine-name constants (framework-name ratchet) (2026-11-15)

**Version / slug:** `cb-framework-constants-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (identical-value refactor)`

## Summary of the change

To pass the framework-name ratchet, the 25 `'claude-code'` / `'codex-cli'` literals this PR added now come from shared constants. The constants are `CLAUDE_CODE_FRAMEWORK`, `CODEX_CLI_FRAMEWORK` and the `ClaudeOrCodexEngine` type, all in `src/core/frameworkFacts.ts`. `scripts/framework-name-ratchet-baseline.json` was rewritten to the real counts: 1122, down from 1135. Every replacement swaps in an identical string value. The `codex-cli@${v}` attempt keys and the `'not-claude-code'` reason text are left unchanged, because changing them would alter stored keys.

This record exists because the merge-time decision audit found `src/core/frameworkFacts.ts` and the baseline file uncovered by the earlier traces.

## Decision-point inventory

None changed. The engine values compared at runtime are byte-identical.

## 1. Over-block

No issue identified.

## 2. Under-block

No issue identified.

## 3. Level-of-abstraction fit

The engine ids now come from the one shared table the ratchet points to.

## 4. Signal vs authority compliance

Unchanged.

## 5. Interactions

A PR that still carries the old baseline of 1135 must merge main after this lands, or its baseline-equality test fails.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the commit.

## Tests

- Ratchet lint is clean at 1122.
- tsc is clean.
- framework-id-ratchet: 19 of 19 pass.
- 12 related unit files: 207 tests pass.

## Follow-up commit (2026-11-15 18:36Z)

`src/commands/postDriveTranscriptAudit.ts`: `DEFAULT_FRAMEWORK` now imports `CODEX_CLI_FRAMEWORK` (same value). The `frameworkFacts.ts` doc comment now says that default or fallback engine ids import the constants too. The ratchet baseline drops to 1121. framework-id-ratchet and the post-drive audit test pass (2 files, 27 of 27).
