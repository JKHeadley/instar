# Side-Effects Review — the anti-pattern step keeps the feature-notes block last (2026-11-15)

**Version / slug:** `awareness-block-stays-last-1115`
**Date:** `2026-11-15`
**Author:** `Echo`
**Second-pass reviewer:** `not required (migration text placement only, no decision logic)`

## Summary of the change

The awareness entry registry (PR #3171, spec `docs/specs/awareness-entry-registry.md`) writes one marked feature-notes block at the END of CLAUDE.md and rebuilds it on every update. PR #3053 adds the first entry. Its Local Verify run failed the idempotency tests (`PostUpdateMigrator-org-intent-runtime`, `mobile-native-capacity-screens-claudemd`). `insertContextDeathClaudeBlock` runs after `migrateClaudeMd`. When the file had no `## Critical Anti-Patterns` section, it appended one AFTER the block. The next update then moved the block back to the end, so CLAUDE.md changed on every run.

The fix: `insertContextDeathClaudeBlock` finds a well-formed registry block (`findRegistryBlock`) and treats its start as the end of the document. It inserts into an existing Critical Anti-Patterns section before that point, or creates the section just before the block. A document with no block takes the same path as before, byte for byte.

## Decision-point inventory

None. The change only decides where text is placed. Nothing is gated, refused or allowed.

## 1. Over-block

No issue identified. Nothing is blocked.

## 2. Under-block

No issue identified. The step still adds the block exactly once (the existing `includes(markerId)` guard runs first).

## 3. Level-of-abstraction fit

The rule "the registry block stays last" lives in the registry spec. This step is the one late writer found in tests. It now respects the rule through the registry's own `findRegistryBlock`, not a second marker parser.

## 4. Signal vs authority compliance

Not applicable: no signal or authority is involved.

## 5. Interactions

- Existing agents nearly all have a Critical Anti-Patterns section with the marker already present, so the step is a no-op for them, as before.
- With a block present and the section present before it, the insertion search is bounded to the text before the block. The `\n## ` search can no longer land on the block's own `## Feature notes` heading.
- Other steps that append to CLAUDE.md after `migrateClaudeMd` could cause the same thing. None showed up in the unit suites run here. Suggested to the merge-line owner: a registry test that appends after the block and re-runs.

## 6. External surfaces

CLAUDE.md placement only, for agents whose file lacked the section. No API, config or message changes.

## 7. Rollback cost

Revert the one function. No state is written beyond CLAUDE.md text, which the next update rebuilds.

## Tests

- Two `migrate()` runs on the org-intent fixture are byte-identical (they differed before).
- `PostUpdateMigrator-org-intent-runtime`, `mobile-native-capacity-screens-claudemd` and the awareness registry tests: 4 files, 88 of 88 passed.
- tsc clean; all 54 lint steps pass.
