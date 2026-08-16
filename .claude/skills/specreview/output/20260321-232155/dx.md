# DX & API Design Review — Consent & Discovery Framework

**Review ID:** 20260321-232155
**Round:** 1
**Spec:** `specs/consent-discovery-framework.md`
**Reviewer Role:** Developer Experience & API Design Specialist
**Date:** 2026-03-21

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec is architecturally sound and well-motivated. There are no fundamental design errors. However, several gaps in the API surface would create real friction for the primary developer audience (AI agents building against this system). These gaps are addressable without redesign.

---

## Research Findings

Before this review, I surveyed:

**Feature flag platforms (LaunchDarkly, Unleash, Flagsmith):**
- All expose a clean resource-per-flag REST model: `GET /flags`, `GET /flags/:key`, `PATCH /flags/:key`
- LaunchDarkly adds lifecycle tracking (stale flag detection, 30-day sunset policies) — analogous to the spec's `discoveryState` progression
- Unleash's dashboard-driven toggle model is a strong parallel to the agent's conversational activation pattern
- Flagsmith combines flags + remote config in one resource — similar to how this spec combines `FeatureRegistration` (flag) + `discoveryState` (lifecycle) in one interface

**REST API naming best practices:**
- Plural nouns for collections (`/features`, not `/feature`)
- Kebab-case for multi-word paths (`/evaluate-context` is correct, `/discoverable` is fine)
- Actions-as-subresources for non-CRUD operations (`POST /features/:id/surface` is idiomatic)
- Avoid verbs in resource paths; use HTTP methods to convey action
- Query parameters for filtering, not separate endpoints for every slice

**Consent management UX:**
- Progressive disclosure is the established best practice — surface essential info first, depth on demand
- Contextual timing outperforms scheduled prompts (the spec's "Context Over Calendar" principle is validated by industry research)
- Audit trails are standard: GDPR-grade systems all maintain event logs (the `discovery-events.jsonl` design is well-aligned)
- "Progressive consent" — embedding choices in user journeys at the moment of relevance — is the leading pattern as of 2025-2026

**AI agent capability discovery:**
- Model Context Protocol (MCP) uses `GET /openapi.json` at a well-known path for self-description — the `GET /features` endpoint in this spec is analogous
- Agent2Agent (A2A) protocol introduced `agent-card.json` at `/.well-known/` in 2025 — a standardized discovery manifest
- Self-describing APIs (schema at known endpoints, machine-readable capability inventories) are the consensus pattern for agent-facing APIs
- The industry is converging on structured catalogs with typed schemas, not freeform descriptions

**Key implication for this spec:** The primary consumers of `/features` are AI agents, not human developers writing curl commands. Agent-readability should be optimized for: machine-parseable schemas, deterministic state transitions, and unambiguous field semantics.

---

## Critical Issues

### 1. `GET /features/discoverable` — Noun-Verb Collision in Path

The endpoint `GET /features/discoverable` is a path segment that collides with `:id` in the route `GET /features/:id`. If `discoverable` happens to also be a valid feature ID, the router will match it as an ID lookup. This is a latent routing bug.

**Fix:** Move to a query parameter: `GET /features?eligible=true` or `GET /features?state=undiscovered,aware`. This is also more composable — callers can filter by multiple states without needing a bespoke endpoint per slice.

### 2. `POST /features/:id/state` — Ambiguous Semantics

The endpoint `POST /features/:id/state` with body `{ state: "declined" }` is doing state *transition* work, but the name implies state *replacement*. This creates two problems:

1. An agent calling this doesn't know whether arbitrary state transitions are allowed or only valid ones. The spec defines a state machine, but the API surface doesn't expose its constraints.
2. There is no transition validation at the API layer described — nothing prevents calling `POST /features/threadline/state` with `{ state: "enabled" }` when the feature has unmet prerequisites.

**Fix:** Rename to `POST /features/:id/transition` with body `{ to: "declined", reason?: string }`. Return a 422 with clear error if the transition is invalid given the current state. The error body should name both the attempted transition and why it failed.

### 3. No Error Response Schema Specified

The API section defines endpoint paths and request shapes but provides zero guidance on error responses. For an agent consuming this API, error handling is not optional — it's the primary failure mode. What does a 404 look like when a feature ID doesn't exist? What does a 422 look like for invalid state transitions? What does a 409 look like if a prerequisite feature isn't enabled?

This is the most significant DX gap. Error legibility is how an agent self-corrects without human intervention.

**Fix:** Add a standard error schema to the API section:
```typescript
interface ApiError {
  error: string         // machine-readable code: "feature_not_found", "invalid_transition", "prerequisite_not_met"
  message: string       // human-readable explanation
  details?: object      // context (e.g., { required: "living-skills", current: "undiscovered" })
}
```
Enumerate the error codes for each endpoint.

### 4. No Response Schema for `POST /features/evaluate-context`

The `DiscoveryEvaluation` return type is defined as a TypeScript interface, but the API section doesn't restate what the endpoint actually returns. An agent calling `POST /features/evaluate-context` has no documented response contract. The TypeScript interface is buried 80 lines above the API section and is easy to miss.

**Fix:** The API section should be self-contained. Repeat the response shape inline in the endpoint description, or cross-reference it explicitly.

---

## Recommendations

### R1. Expose Transition Validity Inline

Add a `validTransitions` field to the `GET /features/:id` response listing which state transitions are currently valid. This lets an agent plan before acting, rather than calling and handling a rejection.

```typescript
// Addition to GET /features/:id response
validTransitions: DiscoveryState[]
```

For example, if the current state is `declined`, the response would include `validTransitions: []` (or the context-change path). This is how well-designed state machine APIs behave — they tell you what's possible, not just what's current.

### R2. Add a `GET /features/summary` or Extend `/capabilities`

The spec says to extend `/capabilities` with discovery state, which is good. But the spec doesn't define what happens when an agent just wants a fast check: "how many features am I missing that are eligible?" A lightweight summary endpoint avoids forcing agents to download the full registry on every session start.

```
GET /features/summary
→ { total: 14, enabled: 6, undiscovered: 4, declined: 2, aware: 2 }
```

This is a 5ms call vs. downloading 14 full `FeatureRegistration` objects. For agents that run this on session start, the difference matters at scale.

### R3. Make `discoveryState` Queryable by Array

The spec's current design requires a separate endpoint for "eligible" features. Instead, expose state filtering via query params:

```
GET /features?state=undiscovered,aware&consentTier=informational,local
```

This gives the context evaluator precise control over what subset to reason over, without bespoke endpoints. It also allows future filter combinations (e.g., by category) without API changes.

### R4. Specify Cooldown Status in Feature Response

The `DiscoveryTrigger` includes `cooldownAfterSurface` and `cooldownAfterDecline`, but the `GET /features/:id` response doesn't include the *current* cooldown state. An agent cannot determine whether surfacing a feature right now would violate its cooldown without making a separate call or re-implementing the cooldown logic.

Add to the response:
```typescript
cooldownExpiresAt?: string   // ISO timestamp, present only if in cooldown
surfaceCount: number         // How many times this feature has been surfaced
```

### R5. Document the `POST /features/evaluate-context` Invocation Contract

The spec says this endpoint runs a Haiku-class LLM evaluation, but doesn't specify:
- Timeout/latency expectations (agents need to know whether to await this synchronously)
- Whether it's idempotent (can it be called twice with the same context safely?)
- Whether calling it automatically records surfaces, or whether a separate `POST /features/:id/surface` call is still required

These are the questions an agent will have in the first 5 minutes of integration.

### R6. Version the API

The spec introduces a significant new API surface. Following REST best practices, endpoint paths should include a version prefix or the system should document its versioning strategy. Even for a local HTTP server, an API that agents have integrated against should version its breaking changes. Consider `/v1/features/...` or at minimum document that this API is `v1` and will be bumped on breaking changes.

### R7. Add an Introspection Endpoint for the State Machine

Since the discovery state machine is central to the framework's behavior, expose it:

```
GET /features/states
→ {
    states: ["undiscovered", "aware", "interested", "declined", "enabled", "disabled"],
    transitions: [
      { from: "undiscovered", to: "aware", trigger: "trigger fires" },
      { from: "aware", to: "declined", trigger: "user declines" },
      ...
    ]
  }
```

Agents and human developers debugging unexpected behavior can query this rather than reading source code. This is especially valuable after compaction, when an agent may have lost context about the state machine rules.

---

## Observations

**What's working well:**

1. **The `ConsentTier` taxonomy is excellent.** The four-tier model (`informational` → `local` → `network` → `autonomous`) maps cleanly to real risk levels and will make consent reasoning legible to both agents and users. This is one of the strongest parts of the spec.

2. **The state machine diagram is clear.** The ASCII state diagram communicates transitions better than prose would. Keep it.

3. **Haiku-class evaluator is the right call.** Using a cheap LLM for context matching rather than string matching is the correct architectural choice (and consistent with the CLAUDE.md anti-pattern guidance). The spec correctly identifies this as classification work, not generation.

4. **One-shot-per-context principle is strong.** This is the correct antidote to notification fatigue. The `maxSurfacesBeforeQuiet` enforcement makes it mechanical, not just advisory.

5. **The Agent Behavioral Contract (DO/DON'T) section is excellent DX documentation.** The surfacing templates give agents a concrete starting point rather than asking them to invent tone from scratch. This is rare and valuable in agent-facing specs.

6. **Integration with self-knowledge tree is well-scoped.** The spec correctly says "no changes needed" for the depth path. Knowing what to NOT build is good spec discipline.

7. **The `disabled` terminal state is appropriately final.** Never re-surfacing a feature the user disabled (unless they ask) is the right default. The spec is explicit about this, which matters.

**Minor nits:**

- The `enableCommand` and `disableCommand` fields in `FeatureRegistration` are typed as `string` but appear to be full API calls (e.g., `curl http://localhost:4042/...`). If they're meant to be machine-callable, they should be structured objects with method, path, and body — not opaque strings. If they're meant for display to users, document that explicitly.

- `configPath` (where in `config.json` the feature lives) is useful but doesn't specify the format — is it a dot-notation path like `"tunnel.enabled"` or a JSON Pointer like `"/tunnel/enabled"`? Pick one and document it.

- The `discoveryTriggers` array in `FeatureRegistration` implies every feature manually codes its triggers. Consider whether a standard `capability-query` trigger should be implicitly applied to all features (since the "what can you do?" path should always surface everything), rather than requiring every feature to register it.

---

## Scalability Assessment

**Current feature inventory:** ~15 features across 4 categories.

At this scale, the spec is well-sized. No pagination is needed for `GET /features`. The `evaluate-context` Haiku call with 15 features in the eligible set is negligible.

**At 50 features:** The `evaluate-context` payload grows. Consider whether the full `FeatureRegistration` object needs to be passed to the evaluator or whether a trimmed `{ id, oneLiner, discoveryTriggers }` representation is sufficient. The spec should state this now so the evaluator isn't inadvertently built to pass full objects.

**At 100+ features:** The session-start evaluation frequency becomes a concern. The spec correctly says "NOT on every message," but session-start on every session could become expensive if features multiply. Consider adding a `GET /features/evaluate-needed` cheap check (just reads state, no LLM) that returns `true/false` before invoking the Haiku evaluator.

**Per-user state (Open Question #2):** The spec acknowledges multi-user discovery state but defers implementation. This is the right call for now, but the data model in `.instar/state/discovery/` should be namespaced from day one (e.g., `discovery/{userId}/feature-states.json`), even if today there's only one user. Retrofitting namespacing later is painful.

**Cross-agent discovery state (Open Question #3):** Keep this out of scope for now. The complexity of syncing discovery state across agents outweighs the benefit at current scale.

**Negative discovery (Open Question #4):** This is worth building eventually but is a separate feature. The current spec correctly excludes it.

---

## Score

**7.5 / 10**

The framework is conceptually mature, the consent tier model is genuinely good design, and the agent behavioral contract is unusually practical for a spec at this stage. The score is held back by the missing error response schema (the most critical DX gap for an agent-facing API), the routing ambiguity in `/features/discoverable`, and the underspecified `POST /features/:id/state` semantics. All of these are fixable in a revision without touching the architecture.

The core ideas — contextual discovery, graduated consent, one-shot-per-context, transparent reversibility — are strong and defensible. This spec should proceed to implementation with the issues above addressed, ideally in a spec revision before Phase 1 begins.
