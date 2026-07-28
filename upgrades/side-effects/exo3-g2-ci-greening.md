# Side-effects — EXO 3.0 G2 (#791) CI greening on post-rebase main

## Change set

- `src/server/CapabilityIndex.ts` — new `agentReadiness` CAPABILITY_INDEX entry
  (prefix `/agent-readiness`, static `configured: true`, one endpoint).
- `src/core/PostUpdateMigrator.ts` — migrateClaudeMd gains the Agent-Readiness
  Scoring section (content-sniffed, idempotent) + the shadow marker
  `'**Agent-Readiness Scoring (EXO 3.0'` in migrateFrameworkShadowCapabilities.
- `tests/unit/feature-delivery-completeness.test.ts` — registers the section in
  featureSections (enforces template + migrator + shadow parity).
- `upgrades/next/agent-readiness-scoring.md` — adds the two user-facing
  sections fragment validation requires.

## Side effects considered

- **/capabilities response grows** by one block; builder is pure/static (no
  ctx dependency — the route is a stateless scorer behind a dynamic import),
  so no probe-path cost or null-ctx risk.
- **Existing agents' CLAUDE.md grows** one section on next migration
  (idempotent via `content.includes` sniff on a distinctive phrase that matches
  both template and migrator variants: 'Agent-Readiness Scoring (EXO 3.0').
- **Shadow files** (AGENTS.md/GEMINI.md) mirror the section; marker bounded by
  the next-marker scan like its siblings.
- **No scorer behavior change**: AgentReadinessScorer and its route untouched.

## Verification

- feature-delivery-completeness + capabilities-discoverability + agent-readiness
  unit/integration/e2e suites green locally; `check-repo-invariants` holds;
  `tsc --noEmit` 0 errors.

## Rollback

Revert this single commit; the feature commits are untouched by it.
