# Side-Effects Review — Register 13 uncategorized LLM components

**Version / slug:** `llm-routing-register-uncategorized-components`
**Date:** `2026-07-01`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds 13 previously-unregistered LLM call-site component names to `COMPONENT_CATEGORY`
in `src/core/componentCategories.ts`, each tagged `sentinel` / `gate` / `reflector`
by function, so the framework router resolves them to a real category instead of
`other` (which falls back to the agent default framework, Claude). Correspondingly
removes those 13 names from the `WIRING_EXCLUSIONS` pinned backlog in
`tests/unit/llm-attribution-ratchet.test.ts`, leaving only the 5 components that
route via an explicit `attribution.category` (so they correctly stay map-unregistered).
Files touched: `src/core/componentCategories.ts`, `tests/unit/llm-attribution-ratchet.test.ts`.
The change interacts with one decision point — the router's category resolution
(`categoryForComponent`) — but only feeds it more data; it adds no branching logic.

## Decision-point inventory

- `categoryForComponent` (src/core/componentCategories.ts) — **pass-through** — unchanged
  function; this change only adds rows to the map it reads. No control-flow edit.
- `IntelligenceRouter.resolveFramework` (per-component framework routing) — **pass-through** —
  consumes the category; unchanged. The 13 components now resolve to their category's
  configured framework instead of the default, which is the intended effect.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. This is a routing-map data change,
not a gate. It changes WHICH provider runs a call, never WHETHER the call is allowed.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. The change cannot make any gate
more permissive; gate *authority* is untouched. (The one `gate`-category addition,
ResumeValidator, keeps its existing behavior; only its provider changes.)

---

## 3. Wrong-provider / routing correctness

**Could a component now route to a provider that can't serve it correctly?**

Low risk. All 13 join categories (`sentinel`/`gate`/`reflector`) that the
Provider-Fallback Default Policy already routes off-Claude for dozens of live
components — the target providers (codex-cli → pi-cli → gemini-cli, Claude last)
are production-exercised. A rate-limited or missing framework degrades via the
existing per-framework circuit breaker + fallback chain (unchanged). No component
routes to a provider class not already in use for its category.

The one behavioral nuance: components that make *nuanced/critical* judgments
(e.g. LLMConflictResolver resolving divergent multi-machine state) now run on a
non-Claude reasoning-capable model (gpt-5.5 via codex) rather than Claude. This is
aligned with the operator directive to prefer subsidized non-Claude subscriptions,
and gpt-5.5 is reasoning-capable. A later nature-based routing pass (operator-reviewed)
will refine per-task model tiers; this change does not lock that in.

---

## 4. Reversibility / rollback

Fully reversible: remove the 13 rows from `COMPONENT_CATEGORY` (and restore them to
`WIRING_EXCLUSIONS`) and routing returns to the prior state. No migration, no state
schema change, no persisted data. An operator can also override any single component
per-agent via `sessions.componentFrameworks.overrides` without touching this map.

---

## 5. Blast radius

Fleet-wide once shipped (it's a core map), but strictly additive and category-consistent.
No new code paths execute; the router simply finds a category where it previously found
none. Existing tests cover it: the wiring ratchet (`llm-attribution-ratchet.test.ts`)
proves every live `.evaluate()` component now resolves, `intelligence-router.test.ts` and
the integration/e2e routing suites remain green. Signal-vs-authority: N/A — no detector
and no authority is added or modified; this is a data-map completion.

---

## 6. Test coverage

- `tests/unit/llm-attribution-ratchet.test.ts` — the drift guard; asserts every literal
  `attribution.component` in `src/` resolves to a registered category or a pinned
  (explicit-category) exception, AND that every pinned exception still resolves to `other`.
  Both sides green after the change.
- `tests/unit/intelligence-router.test.ts`, `tests/unit/standards-coverage-component-category.test.ts`,
  `tests/integration/intelligence-routing-routes.test.ts`,
  `tests/integration/provider-fallback-default-routing.test.ts` — all green.
- No NEW test added: the existing ratchet already IS the structural guard for this
  invariant (adding a duplicate would be noise).
