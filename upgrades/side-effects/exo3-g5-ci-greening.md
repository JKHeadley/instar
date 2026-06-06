# Side-effects — EXO 3.0 G5 (#794) CI greening on post-rebase main

## Change set

- `tests/integration/learning-velocity-routes.test.ts` + `tests/e2e/learning-velocity-lifecycle.test.ts`
  — teardown `fs.rmSync` → `SafeFsExecutor.safeRmSync` (lint compliance; test-only).
- `src/core/PostUpdateMigrator.ts` — migrateClaudeMd Learning-Velocity Metric
  section (content-sniffed, idempotent) + shadow marker
  `'**Learning-Velocity Metric (EXO 3.0'`.
- `tests/unit/feature-delivery-completeness.test.ts` — featureSections entry.
- `upgrades/next/learning-velocity-metric.md` — the two required user sections.

## Side effects considered

- **Existing agents' CLAUDE.md grows** one section on next migration; sniff
  phrase 'Learning-Velocity Metric (EXO 3.0' matches template + migrator variants.
- **Shadow mirror**: marker bounded by the next-marker scan like its siblings.
- **No discoverability change**: `/metrics/learning-velocity` rides the
  already-classified `/metrics` prefix — no CapabilityIndex edit needed.
- **No metric behavior change**: LearningVelocityScorer and its route untouched.

## Verification

- Learning-velocity unit/integration/e2e + completeness suites green locally;
  `check-repo-invariants` holds; destructive lint clean; `tsc --noEmit` 0.

## Rollback

Revert this single commit; feature commits untouched.
