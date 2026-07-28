# Side-effects — EXO 3.0 G3 (#793) CI greening on post-rebase main

## Change set

- `tests/integration/agent-passport-routes.test.ts` + `tests/e2e/agent-passport-lifecycle.test.ts`
  — teardown `fs.rmSync` → `SafeFsExecutor.safeRmSync` (lint compliance; test-only).
- `src/server/CapabilityIndex.ts` — new `agentPassport` entry (prefix `/passport`,
  static `configured: true`, two endpoints).
- `src/core/PostUpdateMigrator.ts` — migrateClaudeMd Agent Digital Passport
  section (content-sniffed, idempotent) + shadow marker
  `'**Agent Digital Passport (EXO 3.0'`.
- `tests/unit/feature-delivery-completeness.test.ts` — featureSections entry.
- `upgrades/next/agent-digital-passport.md` — the two required user sections.

## Side effects considered

- **/capabilities grows** one static block (no ctx dependency; the passport
  builder reads identity/trust/intent lazily inside the route, not the index).
- **Existing agents' CLAUDE.md grows** one section on next migration; sniff
  phrase 'Agent Digital Passport (EXO 3.0' matches template + migrator variants.
- **Shadow mirror**: marker bounded by the next-marker scan like its siblings.
- **No passport behavior change**: AgentPassport module and routes untouched.

## Verification

- Passport unit/integration/e2e + completeness + discoverability suites green
  locally; `check-repo-invariants` holds; destructive lint clean; `tsc --noEmit` 0.

## Rollback

Revert this single commit; feature commits untouched.
