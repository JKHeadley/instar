# Side-effects — EXO 3.0 G1 (#785) CI greening on post-rebase main

## Change set

- `tests/e2e/mtp-protocol-test-action-lifecycle.test.ts` — teardown `fs.rmSync`
  → `SafeFsExecutor.safeRmSync` (lint-no-direct-destructive compliance; test-only).
- `upgrades/next/mtp-protocol-exo3.md` — adds `## What to Tell Your User` +
  `## Summary of New Capabilities` (fragment validation + Repo Invariants).
- `tests/unit/feature-delivery-completeness.test.ts` — registers
  'MTP Protocol — the two EXO 3.0 tests' in `featureSections`.
- `src/core/PostUpdateMigrator.ts` — adds the `'**MTP Protocol — the two EXO
  3.0 tests'` shadow marker to `migrateFrameworkShadowCapabilities` markers[]
  (mirrors the section to AGENTS.md / GEMINI.md).

## Side effects considered

- **Shadow mirror growth**: Codex/Gemini agents gain one more mirrored section
  on their next migration run. Idempotent (`appended.includes(marker)` guard);
  marker omits trailing punctuation so it matches both the template variant
  ("…tests (Phase 5).") and the migrator variant ("…tests."). Risk: none beyond
  a few hundred bytes in shadow files.
- **Slice bounding**: the marker participates in the next-marker boundary scan
  for OTHER sections' slices. Because the MTP section sits adjacent to other
  bold-marker sections, including it actually IMPROVES slice precision (the
  same reason the markers list exists — see the Secret Drop regression note in
  the migrator).
- **No runtime behavior change**: no route, no migration logic, no scheduler,
  no messaging path touched. The only src edit is data (one marker string).
- **Test-only deletions**: SafeFsExecutor in e2e teardown routes through the
  audited funnel; tmpdir-scoped, recursive+force semantics unchanged.

## Verification

- `tests/unit/feature-delivery-completeness.test.ts` + the MTP e2e: 73/73 green locally.
- `node scripts/check-repo-invariants.mjs` → "Repository invariants hold."
- `node scripts/lint-no-direct-destructive.js` → clean.
- `tsc --noEmit` → 0 errors.

## Rollback

Revert this single commit; the feature commit (da33b79a7) and merge commit
(bf8022b1b) are untouched by it.
