# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new capability (ORG-INTENT tradeoff helper — Phase 3). -->

## What Changed

**feat(org-intent-runtime): deterministic tradeoff helper for `ORG-INTENT.md` (Phase 3 of 4).**

Phases 1 (v1.2.23) and 2 (v1.2.24) surfaced the tradeoff hierarchy from `ORG-INTENT.md` to the Coherence Gate at message-review time and to the agent's session-start context. Both use LLM-based reasoning to resolve values collisions. Phase 3 adds a deterministic standalone helper so code paths OUTSIDE the reviewer — research agents, planning passes, future jobs, the agent itself when asked a direct "which value wins?" question — can consult the hierarchy without paying for an LLM call.

The helper is a pure function in a new module:

- `src/core/TradeoffResolver.ts` — exported `resolveTradeoff({ valueA, valueB, hierarchy })` returning `{ winner, basis, explanation, matchedIndexA, matchedIndexB }`. No LLM, no fuzzy matching beyond case-insensitive substring containment. Predictable for any caller.

It is also exposed via a single HTTP route:

- `POST /intent/tradeoff-resolve` — accepts `{ valueA, valueB }` body, loads `ORG-INTENT.md` via `OrgIntentManager.parse()`, applies the resolver, and returns the resolution plus the org's hierarchy.

The resolver applies three strategies in priority order:

1. **Pair-pattern** — entries like "customer trust over speed" honor explicit pairwise statements (also accepts `before`, `above`, `trumps`, `wins over`, `beats`).
2. **List-order** — case-insensitive substring matching against hierarchy entries; the earlier-indexed match wins.
3. **No match** — returns null winner with `basis: 'no-match'` for callers to handle (typically by escalating to value-alignment review).

Per `feedback_signal_vs_authority`: the resolver is SIGNAL — it has no authority over outcomes. The Coherence Gate from Phase 1 remains AUTHORITY for any value-alignment block. The reviewer in the gate continues to use LLM-based resolution from the structured hierarchy; this new helper is for non-reviewer code paths.

Phase 4 (drift detection job) remains queued.

Spec: `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.md`. ELI16 companion: `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md`. Side-effects review: `upgrades/side-effects/org-intent-tradeoff-helper.md`.

## What to Tell Your User

If you have a tradeoff hierarchy in your organizational intent file, your agent can now resolve tradeoff questions deterministically: given two contending values, it can ask the new endpoint which value wins per the hierarchy, and get back a clear answer with a human-readable explanation. The agent uses this when it needs a fast non-LLM tie-break — for example in research or planning code paths.

The new endpoint is purely additive; existing behavior is unchanged. If you don't have a tradeoff hierarchy in your file, the endpoint returns a no-match response and callers fall back to LLM-based reasoning.

## Summary of New Capabilities

- **POST /intent/tradeoff-resolve** — new HTTP route returning a deterministic tradeoff resolution per the org's hierarchy.
- **`resolveTradeoff()` exported function** — pure logic helper usable by any new callsite that wants deterministic hierarchy consultation.
- **Three resolution strategies** — pair-pattern, list-order ranking, and no-match escalation.
- **Migration parity** — existing agents' CLAUDE.md ORG-INTENT subsection gains a Phase 3 curl line automatically.

## Evidence

- Tier 1 unit tests: `tests/unit/TradeoffResolver.test.ts` (16 new tests, all passing). `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` extended with 1 new test for Phase 3 migration (8 total, all passing).
- Tier 2 integration tests: `tests/integration/org-intent-routes.test.ts` extended with 5 new tests for the tradeoff-resolve route (16 total, all passing).
- Tier 3 E2E lifecycle tests: `tests/e2e/org-intent-tradeoff-lifecycle.test.ts` (5 tests mirroring production wiring through `AgentServer` and `createRoutes`, all passing — including the "feature is alive" 200-not-503 check).
- Type-check: `npx tsc --noEmit` clean.
- Lint: clean.
- The full test suite must remain green before merge per Zero-Failure Standard.
