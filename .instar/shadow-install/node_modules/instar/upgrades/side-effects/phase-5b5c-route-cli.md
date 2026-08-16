# Side-effects review — Phase 5b.5.c `instar route` CLI

**Version / slug:** `phase-5b5c-route-cli`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive CLI surface, no behavior change to existing endpoints)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md`

## Summary of the change

Adds `instar route <task...>` — a CLI subcommand that constructs the Phase 5b
composition root (TaskClassifier + OverrideDetector + PreferenceStore +
StaticCatalogProvider + CostStateTracker + TelegramConfirmer + FrameworkModelRouter)
and runs a single classification against a task description.

Pragmatic CLI-first approach: the full HTTP endpoint requires touching
AgentServer's massive injected-dependencies constructor, which is risky to
land overnight without Justin's review. The CLI command lets him test the
end-to-end Phase 5b flow against his real IntelligenceProvider (Claude or
Codex per `INSTAR_FRAMEWORK`) without the AgentServer wiring.

Design choice: the CLI forces `telegramTopicId: null`, which short-circuits
to the catalog-default branch (`source: auto-defaulted-no-topic`). This
is deterministic and testable — no real Telegram round-trip needed. The
TelegramConfirmer is wired with a no-op transport (the gate is never
consulted on this code path; transport is there for type-soundness only).

Files touched:
- `src/commands/route.ts` — new, 140 LOC.
- `src/cli.ts` — added `.command('route <task...>')` block, 13 LOC.

## Decision-point inventory

- **CLI vs HTTP** — `defer`. The HTTP endpoint requires wiring the router
  into AgentServer's constructor, which has 20+ injected dependencies.
  That wiring is tracked separately; the CLI subset is sufficient to
  exercise the composition root and surface integration bugs.
- **No-topic short-circuit** — `add`. Forces the deterministic catalog-
  default branch in CLI context. Caller never sees an unfinished
  confirmation. Per spec: "no Telegram topic → auto-default with note."
- **Framework selection** — `add`. CLI accepts `--framework` flag plus
  falls through to `frameworkFromEnv()` plus default `claude-code`. Honors
  Tier 1.C's stated precedence.

## Signal vs authority

The CLI is a thin authority — it constructs the router and prints the
result. The router itself is the authority for the routing decision;
this CLI doesn't override or filter anything. Safe by construction.

## Over-block / under-block analysis

**Over-block:** None — the command is read-only with respect to runtime
state (does write to `framework-model-preferences.db` if the router
takes a cache-writing branch, but the CLI's no-topic path doesn't write).

**Under-block:** A user could pass `--framework codex-cli` without having
Codex installed; the `buildIntelligenceProvider` call would return null
and the CLI exits with a clear error. Verified by the explicit null-check
in route.ts.

## Level-of-abstraction fit

- Lives in `src/commands/route.ts` alongside other CLI entrypoints.
- Imports the Phase 5b composition root by interface, not by concrete
  type — same pattern as existing CLI subcommands (`gate`, `playbook`,
  `memory`).
- Does NOT touch AgentServer, HTTP routes, or Telegram wiring. That
  scope is intentionally deferred.

## Interactions

- **`FrameworkModelRouter` (Phase 5b.4)** — consumed unchanged.
- **`buildIntelligenceProvider` (Tier 1.C)** — consumed unchanged.
- **`PreferenceStore`** — creates a sqlite file at `<stateDir>/framework-
  model-preferences.db` if it doesn't exist. The path is stable across
  CLI runs and any future HTTP wiring; both will share the cache.
- **No existing source files modified** except `src/cli.ts` (additive
  command registration).

## External surfaces

- New CLI command: `instar route <task...> [--user <id>] [--description <text>]
  [--framework <name>] [--json] [-d <dir>]`.
- No new endpoint, no new config field, no new environment variable.

## Rollback cost

Trivial. `git revert` removes the two files / hunks. No other code consumes
the CLI command.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest run tests/unit/providers/uxConfirm/` — 124/124 pass (existing
  router tests cover the no-topic branch the CLI invokes).
- No new tests for `route.ts` itself: it's a thin composition wrapper
  whose behavior is fully covered by `FrameworkModelRouter.test.ts`
  ("auto-defaulted-no-topic" path) and `intelligenceProviderFactory.test.ts`
  (framework selection). A test for `route.ts` would just be re-asserting
  those wired together, with no new edge cases.
- End-to-end smoke: invoking `node dist/cli.js route "refactor this function"`
  on a Claude-installed machine should print `framework: claude-code`,
  `model: opus-4.7` (the catalog default for code-refactor patterns).
  Verified manually post-build; full live verification deferred to the
  morning hand-back.
