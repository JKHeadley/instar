# Side-effects review — Phase 5b.5.a (StaticCatalogProvider)

**Version / slug:** `phase-5b5a-static-catalog-provider`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (hand-curated data tables with deterministic lookup; no decision logic, no LLM, no I/O)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md` (acceptance criteria #1 — implementable CatalogProvider)

## Summary of the change

First fragment of Phase 5b.5 (the production-wiring slice). Lands the concrete `CatalogProvider` implementation that the `FrameworkModelRouter` consumes — a hand-curated TypeScript module derived from the Phase 5a catalog markdown (`08-model-fitness-catalog.md`, `09-framework-fitness-catalog.md`).

### Why hand-curated vs markdown parser

The catalog markdown is the human source-of-truth — it contains 10x more data than the router needs (justifications, source citations, "avoid for" sections, etc.). A markdown parser would have two failure modes:

1. **Over-fit current structure** → brittle. The catalog evolves as new research lands; new sections, reordered headings, and reworded bullets would each be a breaking change.
2. **Under-extract** → lossy. Even a robust parser would mis-classify ambiguous confidence markers and miss task patterns not explicitly tabulated.

A hand-curated runtime catalog forces a deliberate update when the markdown changes meaningfully — a feature, not a bug. The runtime catalog only needs: defaults per task pattern, confidence per (pattern, framework, model) tuple, a version string. All of which fit comfortably in static tables.

### Contents

- `CATALOG_VERSION = '2026-05-15.v0.1'` — date-stamped version that Phase 5b's TriggerGate compares against the cached snapshot.
- `DEFAULTS_BY_PATTERN` — 20 curated task patterns mapped to `{ framework, model, confidence }`. Patterns chosen to cover the common task shapes the classifier emits (`code-generation`, `code-refactor-typescript`, `web-research`, `summarize-meeting-transcript`, `shell-one-liner`, `agentic-execution`, etc.).
- `GLOBAL_DEFAULT` — Claude Code + Opus 4.7 @ LOW confidence — the safe fallback for unknown patterns.
- `CONFIDENCE_BY_FRAMEWORK_MODEL` — per-tuple confidence baselines for non-default combinations (e.g., user overriding to Codex CLI for a refactor task).
- `StaticCatalogProvider` class implementing the `CatalogProvider` interface.

Files touched:
- `src/providers/uxConfirm/StaticCatalogProvider.ts` — new, 180 LOC (mostly data tables + the lookup methods).
- `tests/unit/providers/uxConfirm/StaticCatalogProvider.test.ts` — new, 16 cases.

## Decision-point inventory

This change ADDS a data source. It is itself a tiny decision point (which framework+model is the default for a pattern) but every "decision" is a static lookup — no LLM, no I/O, no async.

- **`defaultFor(taskPattern)`** — `add`. Static table lookup with global fallback.
- **`confidenceFor(taskPattern, framework, model)`** — `add`. Static table lookup with three-tier resolution: (1) match the documented default → cite its confidence; (2) match the framework|model baseline → cite that; (3) PROVISIONAL fallback.
- **`currentVersion()`** — `add`. Constant getter (or constructor-overridable for tests).

No new gates, sentinels, watchdogs, or filters. No blocking surface.

## Signal vs authority

This is pure data. The `FrameworkModelRouter` (Phase 5b.4) is the authority that consumes the data — not this provider.

## Over-block / under-block analysis

**Over-block:** Hand-curated tables can lag the markdown. If a new task pattern lands in the catalog markdown without being added here, the router routes it through `GLOBAL_DEFAULT` (Claude Code + Opus 4.7 LOW) — which fires `ask-new-pattern` on the gate side and gets re-confirmed by the user. Self-healing: the next time someone updates this file, they pick up the lag and the pattern auto-resolves to its proper default.

**Under-block:** If a confidence rating in the markdown drops without being reflected here, the gate won't fire `ask-low-confidence` for that combination. Mitigation: when updating the markdown, bump `CATALOG_VERSION` AND update `CONFIDENCE_BY_FRAMEWORK_MODEL`. A future addition (Phase 5b.5.b or later) could add a build-time validator that diffs the markdown against the table.

## Level-of-abstraction fit

The provider lives in `src/providers/uxConfirm/` alongside the router that consumes it. It depends only on the `CatalogProvider` interface and the `ConfidenceLevel` type — no other provider-portability infrastructure. Clean isolation.

## Interactions

- **Phase 5b.4 (`FrameworkModelRouter`)** — direct consumer. Router constructed with `new StaticCatalogProvider()` in production wiring.
- **Phase 5a catalog markdown** — source-of-truth that this file mirrors. Hand-maintained in lockstep.
- **No existing source file is modified.** Pure addition.

## External surfaces

- New exports: `StaticCatalogProvider`, `StaticCatalogProviderOptions`, `CATALOG_VERSION`.
- No new endpoint, no new CLI command, no new config field.
- The `CATALOG_VERSION` string is part of Phase 5b's cache-invalidation contract — bumping it forces every cached preference to re-evaluate on next gate run. Bump deliberately.

## Rollback cost

Trivial. `git revert` removes two files. No persistent state.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/StaticCatalogProvider.test.ts` — 16/16 pass.
- Cumulative uxConfirm coverage: 115 tests passing (99 prior + 16 new).
- Test coverage: version default + override, six curated pattern defaults (code-generation, code-refactor-typescript, web-research, summarize-meeting-transcript, shell-one-liner, agentic-execution), global fallback for unknown patterns, default-pick confidence precision, non-default baseline lookup, translation-proxy combinations, unknown-tuple PROVISIONAL fallback, knownPatterns().
- No real-API verification needed — purely deterministic.
