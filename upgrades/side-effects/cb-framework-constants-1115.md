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

## Follow-up commit (2026-11-15 18:45Z)

Four WIRED e2e tests read `src/commands/server.ts` as text. Three expected the old `'codex-cli'` literal in `engineInScope` and in the codex adapter-suite wiring, and now expect `CODEX_CLI_FRAMEWORK`, which is what the wiring actually says. `context-layer-h3-alive` expects `h3Builder: _h3Builder ?? undefined,` with its comma, so the AgentServer constructor call lists `h3Builder` before `contextLayers` again. No behaviour change. I checked every literal those four tests expect against the source files: all present.

## Follow-up commit (2026-11-15 21:40Z)

The integration test post-compact-route failed on the M5: a PostCompact from a job session (no topic, no name) answered 500 instead of `{recorded:false, reason:'no-topic'}`. `pressTargetRefusal` called `s.name.startsWith` on a session record with no name. It now refuses with `not-throwaway` when the name is not a string, the same answer a non-throwaway name gets, so nothing that was refused before is now allowed. A unit case covers it. synthetic-press 9/9, post-compact-route integration 6/6, tsc clean.
