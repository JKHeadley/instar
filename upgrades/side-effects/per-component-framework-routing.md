# Side-Effects Review — Per-component framework routing (B1)

**Version / slug:** `per-component-framework-routing`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Tier:** `2` (new capability; converged + approved spec: docs/specs/per-component-framework-routing.md)
**Second-pass reviewer:** `not required (the converged spec already carries a 2-reviewer adversarial+integration pass)`

## Summary of the change
Adds an `IntelligenceRouter` at the single LLM funnel so different internal components
(sentinels, gates, …) can be routed to different agentic frameworks (e.g. all sentinels on
Codex while the agent stays on Claude), to move that LLM chatter off the Claude rate-limit
budget. ABSENT-by-default config ⇒ byte-identical to today.

New / changed:
- `src/core/componentCategories.ts` (NEW) — component-name → category registry + resolver.
- `src/core/IntelligenceRouter.ts` (NEW) — funnel-level, per-call, per-framework routing with
  per-framework circuit breakers and circuit-aware fallback.
- `src/core/intelligenceProviderFactory.ts` — additive `breaker?` option threaded to the wrap
  calls (lets the router give each framework its OWN breaker).
- `src/core/CircuitBreakingIntelligenceProvider.ts` — `wrapIntelligenceWithCircuitBreaker`
  gains an optional `breaker` param (default unchanged = global singleton).
- `src/core/types.ts` — additive `attribution.category?` on IntelligenceOptions; additive
  `sessions.componentFrameworks?` config (TYPE-ONLY — NOT added to ConfigDefaults).
- `src/commands/server.ts` — wrap the shared provider in the router in its OWN try/catch.
- `tests/unit/intelligence-router.test.ts` (NEW) — 11 tests.

## Decision-point inventory
- `IntelligenceRouter.evaluate` routing — **add** — chooses WHICH framework answers; no
  block/allow authority (providers are signal). The one safety branch is fallback (D4).
- `wrapIntelligenceWithCircuitBreaker` / factory `breaker?` — **modify (additive)** — default
  path unchanged; only the router passes a distinct breaker.

## 1. Over-block / 2. Under-block
No block/allow surface — providers are SIGNAL. The router cannot block a running agent; the
worst it does is degrade-and-report (D4). Unconfigured, it is a transparent passthrough.

## 3. Level-of-abstraction fit
Correct — the router sits at the existing `CircuitBreakingIntelligenceProvider` funnel (the
one chokepoint every `.evaluate()` already passes), so it covers ALL callers (including the
config-path and inline-closure ones) without editing 38 call sites — Structure > Willpower.

## 4. Signal vs authority compliance
**Reference:** docs/signal-vs-authority.md. [x] No block/allow surface of its own. Routing
changes which model answers; it adds no gate. The per-framework breakers are the existing
breaker authority, now correctly ISOLATED per framework (a Claude trip no longer pauses Codex)
— a correctness improvement, not a new authority.

## 5. Interactions
- **Breaker isolation:** each non-default framework gets a distinct `new LlmCircuitBreaker()`
  (proven by unit test — a routed call reaches a different provider instance than the default).
  The default framework keeps the global singleton, so status/health surfaces are unchanged for
  it. (Per-framework breaker states are additionally surfaced via GET /intelligence/routing —
  part 2 of B1, see "Remaining".)
- **Fallback (D4):** binary-missing → degrade to default + DegradationReporter (no silent
  fallback — composes with Task-1's re-armed gate); rate-limited → LlmCircuitOpenError
  propagates and the caller swallows it into its heuristic (NO herd onto Claude).
- **Cascade-503:** the router is built in its OWN try/catch in server boot; a build failure
  leaves the raw provider, never 503s the server.
- **Config:** type-only; NOT in ConfigDefaults (applyDefaults deep-merge would otherwise inject
  it everywhere and break absent-equals-unchanged).

## 6. External surfaces
- (Remaining in this PR) `GET /intelligence/routing` read-only surface + its CapabilityIndex
  classification (the #727 lesson). No persistent state. Config: `sessions.componentFrameworks`
  (opt-in, absent by default).

## 7. Rollback cost
Pure additive + opt-in. Remove `componentFrameworks` (or revert) → every call routes to the
single shared provider exactly as today. No state, no migration.

## Conclusion
B1 complete across all three test tiers (tsc clean): per-call funnel resolution,
per-framework breaker isolation, circuit-aware fallback, live-config (hot), the category
registry, factory breaker-threading, config type, server wiring, the `GET /intelligence/routing`
read surface (+ CapabilityIndex INTERNAL_PREFIXES classification — the #727 lesson),
CLAUDE.md agent-awareness (template + migrateClaudeMd for existing agents). Tests: 11 unit
(`intelligence-router.test.ts`) + 3 integration (`intelligence-routing-routes.test.ts`,
200/503) + 3 e2e (`intelligence-routing-lifecycle.test.ts`, feature-alive on the real
AgentServer init path + Bearer-auth + read-only). The design was converged (2-reviewer
adversarial+integration) which corrected the breaker-isolation and resolution-point design
before any code — see the spec's Convergence Report. B2 (gates/reflectors + per-framework
spend accounting + dashboard view) is a deliberate follow-up.

## Evidence pointers
- `tsc --noEmit` clean.
- `vitest run tests/unit/intelligence-router.test.ts` → 11/11 pass (resolution precedence,
  dispatch, per-framework instance isolation, fallback both modes, live-config hot, for() surface).
