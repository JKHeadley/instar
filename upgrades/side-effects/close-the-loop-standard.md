# Side-Effects Review — Close the Loop (Untracked = Abandoned) constitution standard

**Slug:** `close-the-loop-standard`
**Date:** 2026-05-31
**Author:** echo
**Spec:** `docs/specs/close-the-loop-standard.md` (review-convergence + approved by Justin, Telegram 13435)

## Summary of the change

Declares a new constitutional standard — **Close the Loop (Untracked = Abandoned)** —
in the Standards Registry, and propagates the operating principle to agents via the
template (new agents) and a migration (existing agents). Documentation + CLAUDE.md
awareness only; **no runtime behavior change**.

**Files changed (source):**
- `src/scaffold/templates.ts` — adds the `**Close the Loop (Untracked = Abandoned)**`
  bullet to the agent template's Core Principles, immediately after `**Deferral =
  Deletion**`.
- `src/core/PostUpdateMigrator.ts` — adds an idempotent `migrateClaudeMd` block that
  appends the principle to existing agents' CLAUDE.md, content-sniffed on the marker
  `Close the Loop (Untracked = Abandoned)` (the same string the template emits).

**Files changed (docs):**
- `docs/STANDARDS-REGISTRY.md` — the standard itself, after `### Deferral = Deletion`.
- `docs/specs/close-the-loop-standard.md` (+ `.eli16.md`) — the spec + plain-English overview.

**Files changed (tests):**
- `tests/unit/PostUpdateMigrator-closeTheLoop.test.ts` — +7 tests (add / idempotent /
  no-double-patch / preserve / graceful-skip / registry-declares / template-emits).
- `tests/unit/feature-delivery-completeness.test.ts` — registers the new migrator
  section in `legacyMigratorSections` (a core principle, not a user-invokable capability).

## Blast radius

Confined to CLAUDE.md text and the registry doc. No endpoint, route, store, job, hook,
config default, or skill is added or changed. The migration only ever *appends* a
markdown section to an existing CLAUDE.md and is a no-op once the marker is present.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| New agent `init` | template Core Principles has Structure>Willpower … Deferral=Deletion | …plus **Close the Loop** |
| Existing agent update | CLAUDE.md lacks the principle | migration appends the **Close the Loop** section once |
| Agent already has the principle (new or already-migrated) | present | unchanged (content-sniff skips — no double-patch) |
| CLAUDE.md missing | graceful skip | graceful skip (unchanged) |
| Runtime (gates, jobs, routes) | — | **identical** (no runtime change) |

## Risks considered

- **Double-patching a fresh agent?** No. The template bullet and the migration share
  the exact content-sniff string `Close the Loop (Untracked = Abandoned)`, so a
  newly-initialized agent (which already has it from the template) is skipped by the
  migration. Covered by an explicit test.
- **Idempotency?** Yes — re-running the migration finds the marker and does nothing;
  test asserts exactly one heading after a double run.
- **Framework-shadow (Codex/Gemini) parity?** Not required: this is a core operating
  *principle* (tracked in `legacyMigratorSections`, like Deferral = Deletion and the
  anti-confabulation discipline), not a user-invokable capability that needs the
  `migrateFrameworkShadowCapabilities` markers[]. (Whether Core Principles in general
  should reach Codex/Gemini agents is a pre-existing question, out of scope here.)
- **Existing tests?** `feature-delivery-completeness` enforces every migrator section is
  tracked; the new section is registered. 69 tests pass across the new + completeness +
  anti-confabulation suites; `tsc --noEmit` clean.

## Migration parity

Handled: template (new agents) + `migrateClaudeMd` content-sniffed append (existing
agents). No other agent-installed file (hook / config default / skill) is touched.
