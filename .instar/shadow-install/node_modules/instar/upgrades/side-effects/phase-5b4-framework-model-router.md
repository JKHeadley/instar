# Side-effects review — Phase 5b.4 (FrameworkModelRouter composition root)

**Version / slug:** `phase-5b4-framework-model-router`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (composition root over five already-tested components; every flow path covered by deterministic unit tests against in-memory store + stub catalog + stub confirmer)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md`

## Summary of the change

Fourth implementation slice of Phase 5b — the composition root that ties every previous slice together. `FrameworkModelRouter` lives in `src/providers/uxConfirm/FrameworkModelRouter.ts` and implements the full decision flow from §"Decision flow" of the spec.

Routes a task by:

1. Classifying via `TaskClassifier` → `taskPattern`.
2. Short-circuiting on unclassified or non-Telegram-topic origin → catalog default with note source.
3. Looking up cached preference in `PreferenceStore`.
4. Capturing current cost state via `CostStateTracker.snapshot()`.
5. Running `runTriggerGate` to decide silent-use or ask.
6. On ask: calling `TelegramConfirmer.confirm(prompt)` with the right reason kind and detail.
7. Applying the confirmation result — updating cache on `confirmed` (with cache) or `overridden` (this-pattern scope); clearing cache on `reset`; never caching on `confirmed-one-shot`, `overridden-this-task`, or any auto-default path.

Returns a `RouteResult` with `{ framework, model, taskPattern, source, catalogDefault }`. The `source` field is the audit trail — eight distinct values cover every flow path so downstream code (and the dashboard's historical view) can show exactly why this pick was made.

The `CatalogProvider` interface abstracts over Phase 5a's catalogs (`08-model-fitness-catalog.md`, `09-framework-fitness-catalog.md`). The router doesn't read markdown — a CatalogProvider implementation does, and the router consumes its three methods (`currentVersion`, `defaultFor`, `confidenceFor`).

Files touched:
- `src/providers/uxConfirm/FrameworkModelRouter.ts` — new, 248 LOC.
- `tests/unit/providers/uxConfirm/FrameworkModelRouter.test.ts` — new, 13 cases covering all eight `source` outcomes plus confirmer-invocation arguments.

## Decision-point inventory

This change is the central Phase 5b decision authority. Every UX outcome flows through it.

- **`FrameworkModelRouter.route(input)`** — `add`. The authority for "which framework+model runs this task." Returns a structured result; doesn't itself dispatch the task — that's a downstream concern.
- **Cache-write decisions** — `add`. Implemented internally:
  - `confirmed` + `cache: true` → write cache.
  - `confirmed-one-shot` (`cache: false`) → do NOT write cache.
  - `overridden-this-pattern` → write cache with overridden framework/model.
  - `overridden-this-task` → do NOT write cache.
  - `reset` → clear cache.
  - All auto-default paths → no cache change.

The eight-value `RouteSource` enum exhaustively covers every flow. TypeScript's discriminated-union checks ensure no case is dropped.

## Signal vs authority

The router IS the authority. It composes five signal producers (classifier, store, gate, confirmer, tracker) into a single decision. Each producer is fail-safe in its own direction (classifier→unclassified, gate→silent-use only when truly safe, confirmer→default-no-reply on timeout) so the router's worst-case behavior is "pick the catalog default with a noted source" — never wrong, occasionally over-cautious.

## Over-block / under-block analysis

**Over-block (silent auto-default when user wanted a prompt):**
- Background work (no `telegramTopicId`) always auto-defaults, by design. This is locked behavior per Justin's Rule 1.
- Unclassified pattern (classifier returned fallback) also auto-defaults rather than risking a wrong cache key. Spec §"Edge cases" mandates this.

**Under-block (cache-write without user intent):**
- The router writes cache only on explicit `confirmed:cache=true` or `overridden:scope=this-pattern`. Both come from the user's reply via the confirmer. No silent cache writes.
- `auto-defaulted-no-reply` does NOT update the cache — important: a user who walks away during a confirmation should not have their state mutated.

## Level-of-abstraction fit

- The router doesn't reach into Telegram, sqlite, or LLM internals. It composes interfaces. The `CatalogProvider` abstraction means Phase 5a catalog changes don't ripple here.
- All five injected components are constructor params — easy to test, easy to swap implementations (alternative messaging adapter, different catalog provider, alternative classifier model).

## Interactions

- **Phase 5b.1 (`PreferenceStore`, `TriggerGate`)** — direct dependencies. The router writes the store and reads via the gate.
- **Phase 5b.2 (`TaskClassifier`, `OverrideDetector`)** — classifier is a direct dep; detector is consumed transitively via the confirmer.
- **Phase 5b.3 (`TelegramConfirmer`)** — direct dep; confirmation is delegated.
- **Phase 5c (`CostStateTracker`)** — direct dep; the gate consumes the tracker via the router's pass-through.
- **Phase 5a artifacts (catalogs)** — consumed through `CatalogProvider`. The actual provider implementation that reads `08-model-fitness-catalog.md` and `09-framework-fitness-catalog.md` is NOT in this commit — that's part of the final wiring slice.
- **No existing source file is modified.** Pure addition.

## External surfaces

- New exports: `FrameworkModelRouter`, `FrameworkModelRouterOptions`, `CatalogProvider`, `RouteInput`, `RouteResult`, `RouteSource`.
- No new endpoint, no new CLI command, no new config field. Production wiring (server.ts composition root, real CatalogProvider implementation, wiring TelegramAdapter into ConfirmationTransport) lands in the final slice — `Phase 5b.5: wire into server startup`.

## Rollback cost

Trivial. `git revert` removes two files. No persistent state, no runtime callsite consumes the router yet.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/` — 99/99 pass cumulative (11 store + 12 gate + 13 classifier + 20 detector + 30 confirmer + 13 router).
- Router test coverage: every `RouteSource` value is asserted by at least one test (cached-silent, confirmed, confirmed-one-shot, overridden-this-task, overridden-this-pattern, reset-defaulted, auto-defaulted-no-topic, auto-defaulted-no-reply, auto-defaulted-unclassified). Cache-write assertions verify each path's effect on the store. The confirmer-argument test asserts the right reason kind and prompt fields make it to the confirmer.
- No real-API verification needed — composition root over already-tested components. Live integration (real Telegram, real LLM, real catalog) lands at the wiring slice.
