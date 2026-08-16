# Architecture Review: Consent & Discovery Framework

**Review ID:** 20260321-232155
**Round:** 1
**Spec:** consent-discovery-framework.md
**Reviewer:** Systems Architect (Echo)
**Date:** 2026-03-21

---

## Approval Status

**APPROVED WITH CONDITIONS**

The spec is well-reasoned, the principles are sound, and the architecture is appropriate for the problem space. Two conditions must be satisfied before Phase 3 implementation begins: (1) the multi-user discovery state isolation must be explicitly designed, not assumed; and (2) the LLM evaluator's failure modes need a defined fallback contract. Neither is a blocker for Phases 1–2.

---

## Score: 8/10

Strong spec. The design principles are coherent, the state machine is clean, and the integration surface is appropriately narrow. Docked points for two gaps: the multi-user state isolation is called out as an open question but not yet resolved, and the LLM evaluator sits on the critical path with no fallback defined.

---

## Research Findings

### Feature Flag Systems (LaunchDarkly, Unleash)

LaunchDarkly evaluates flags locally in-process with an in-memory cache that never expires. If the flag service is unreachable, the SDK falls back to cached values — the application never blocks. This is the canonical pattern for local-first feature flagging: **evaluation is always available, sync is best-effort.**

The spec's `FeatureRegistry` follows this pattern implicitly — state lives in `.instar/state/discovery/` on disk — but it should make this explicit: discovery state evaluation must never depend on an async operation completing. If the LLM evaluator call fails, feature surfacing silently skips, not errors.

LaunchDarkly also enforces a clear separation between **flag definition** (schema, metadata, rules) and **flag state** (current value per context). The spec conflates these slightly — `FeatureRegistration` mixes static metadata (`oneLiner`, `fullDescription`, consent tier) with dynamic state (`enabled`, `discoveryState`). At low scale this is fine, but separating them now would make the registry cleaner to evolve.

### State Machine Patterns for Consent Flows

Progressive disclosure research confirms the spec's instincts are correct: staged, contextual disclosure consistently outperforms upfront feature tours for both comprehension and conversion. The four-variant taxonomy — conditional, staged, contextual, progressive enabling — maps directly to the spec's three surfacing levels (awareness, suggestion, prompt), with "progressive enabling" matching the graduated consent tier requirement (local before network before autonomous).

One notable gap in the spec relative to established consent patterns: there is no explicit **"remind me later"** transition. Current design has `aware → declined` as a single path, but users often want to defer without declining. This is worth adding as a distinct state or cooldown mechanism to prevent false-negative classification of non-engaged users as declined.

### LLM-Based Classification in Production

Production evidence for lightweight LLM classifiers is strong. Classification is well-established as one of the highest-ROI LLM use cases precisely because:
- Failure modes are forgiving (miss a feature mention, not a crash)
- Evaluation criteria are declarative (no training data, no fine-tuning)
- Haiku-class models achieve >60% agreement with human judgment in contextual tasks

The spec's choice of Haiku-class for the evaluator is well-justified. One production concern that doesn't appear in the spec: **prompt drift**. As the feature registry grows, the evaluation prompt grows with it. At 5 features the context is trivial; at 25+ features the prompt may exceed comfortable Haiku context windows and degrade classification quality. The spec should define a max-eligible-features-per-evaluation bound and a strategy for handling large registries (batching, priority ordering, or pre-filtering by category).

### Agent Framework Capability Discovery Patterns

Current frameworks (LangGraph, CrewAI, Google ADK) handle capability discovery primarily through tool registration — agents expose a manifest of callable tools, and orchestrators route requests accordingly. This is a pull model: the user (or orchestrating agent) queries what's available.

The spec introduces a **push model** layered on top of the pull model: the agent proactively surfaces capabilities when context warrants. This is architecturally novel in the agent framework space — most frameworks leave this to application logic. The spec is correct that this belongs in infrastructure, not in ad-hoc agent behavior. Standardizing it as a first-class capability rather than leaving it to prompt instructions is the right call.

---

## Critical Issues

### 1. Multi-User Discovery State Is Unresolved (Blocker for Phase 1 Design)

The spec acknowledges this in Open Questions: "In multi-user setups, each user should have independent discovery state. The spec assumes this but the implementation needs to handle it explicitly."

This cannot remain implicit into Phase 1 implementation. The storage path `.instar/state/discovery/` needs to be scoped. Options:

- `.instar/state/discovery/{userId}/` — per-user directories
- `.instar/state/discovery-events.jsonl` with `userId` field and query-time filtering

The choice affects the `DiscoveryEvent` schema (does it include `userId`?), the `GET /features` endpoint (does it require user context?), and the cooldown logic (per-user or global?). Phase 1 should make this concrete, not defer it to Phase 2.

**Recommendation:** Add `userId` to `DiscoveryEvent`, scope state files per-user, and ensure all API endpoints that return discovery state accept a user context header (or derive it from session).

### 2. LLM Evaluator Has No Defined Fallback

The context evaluator sits on the critical path for session start behavior. If the Haiku API call fails (network down, quota exceeded, latency spike), what happens? The spec is silent.

For a local-first system, API unavailability is a realistic steady state — users may be on planes, or running in offline mode. The framework must degrade gracefully.

**Recommendation:** Define the fallback contract explicitly: evaluator failure means no proactive surfacing for that session, but pull path (`/capabilities`, explicit queries) remains fully functional. This is the right behavior — it just needs to be stated so implementors don't accidentally make session start blocking.

---

## Recommendations

### R1: Split Static Metadata from Dynamic State in FeatureRegistration

`FeatureRegistration` currently holds both immutable metadata (`oneLiner`, `consentTier`, `prerequisiteFeatures`) and mutable state (`enabled`, `discoveryState`). As the feature count grows, this conflation makes caching and invalidation harder.

Consider splitting into:
- `FeatureDefinition` — static, defined in code, never changes at runtime
- `FeatureState` — dynamic, stored in `.instar/state/`, changes with user interactions

The `GET /features` endpoint merges them at query time. This is the LaunchDarkly pattern and it scales cleanly.

### R2: Add a "Deferred" Discovery State

The current state machine has no path for "I'm interested but not right now." A user who ignores a feature mention may be busy, not disinterested. Treating silence as a soft decline (via `maxSurfacesBeforeQuiet`) is reasonable, but an explicit "defer" option gives users agency without the finality of "declined."

Proposed addition:
```
aware → deferred   (user says "remind me later" or similar)
deferred → aware   (after a time-based cooldown, re-eligible for triggering)
```

This prevents the framework from classifying temporarily-distracted users as disinterested, improving the signal quality of the `declined` state.

### R3: Define Prompt Size Budget for Context Evaluator

As the registry grows, the evaluator prompt will grow. At 20+ features, a Haiku-class model may begin degrading in classification accuracy. Define:
- Maximum features passed per evaluation call (suggested: 8–10)
- Priority ordering for when the eligible set exceeds the cap (prefer lower ConsentTier, prefer features where `discoveryState === 'undiscovered'` over `'aware'`)
- A pre-filter step that prunes by category match before sending to LLM

This keeps evaluation cost and quality predictable as the system scales.

### R4: Make `configPath` a Structured Reference, Not a String

The `configPath: string` field in `FeatureRegistration` is used to locate where in `config.json` a feature's enabled state lives. If this is a free-form string like `"tunnel.enabled"`, it's brittle — typos fail silently and there's no compile-time validation.

Consider: a typed reference to the `InstarConfig` schema, or at minimum a validated dot-notation path with a startup-time check that the path resolves against the actual config object.

### R5: Discovery Analytics Should Be Defined Before Phase 5

Success Criteria #3 ("enable rate > 30% for contextual suggestions") requires a clean funnel. If the event log schema drifts between Phase 2 and Phase 5, backfilling metrics becomes painful. Define the analytics schema and the aggregation queries in Phase 2 even if the UI ships in Phase 5. This is a one-hour investment that prevents a one-week retrofit.

---

## Observations

### What the Spec Gets Right

**The design principles are load-bearing, not decorative.** "Context Over Calendar," "One-Shot Per Context," and "Awareness != Activation" are enforceable constraints, not aspirational guidelines. Each one eliminates a specific failure mode (spam on schedule, repeat nagging, pressure selling). This is good spec writing.

**The agent behavioral contract (DO/DON'T) is concrete.** Most specs leave agent behavior to "use good judgment." This one gives implementors testable rules: never surface more than one feature per turn, never surface during crisis debugging, always include reversibility note. These can be evaluated in review.

**The integration surface is appropriately narrow.** The spec extends `/capabilities` rather than replacing it, reuses the self-knowledge tree for depth, and adds only what's necessary to `/features`. This is correct — it doesn't overengineer the integration points.

**Graduated consent tier sequencing is correct.** Requiring at least one `local` tier feature before surfacing `network` or `autonomous` tier features is the right trust-building sequence. This mirrors how good UX practitioners approach progressive trust building.

**The LLM evaluator is scoped correctly.** Haiku-class for classification, not generation. Runs on session start and problem detection, not every message. This is exactly the right cost/value tradeoff.

### Structural Concerns (Minor)

**The `enableCommand` / `disableCommand` fields are API calls as strings.** This could be typed more strongly — a structured `EnableAction` with method, path, and body fields would be safer than free-form command strings. Low priority for MVP, but worth noting.

**`POST /features/evaluate-context` is underspecified.** The spec shows the `DiscoveryContext` input type but doesn't define the request body schema for this endpoint. Implementors will need to decide: does the server construct the context internally from session state, or does the caller provide it? For a local server with session access, server-constructed is cleaner and avoids information leakage from callers.

**Cooldown tracking is mentioned but not fully specified.** `cooldownAfterSurface` and `cooldownAfterDecline` are `Duration` type, but Duration isn't defined. Is this milliseconds? ISO 8601? An enum of named durations? Needs to be concrete before Phase 2.

**The success criterion "no user should feel pestered" is unverifiable without a feedback path.** The spec references "qualitative, monitored via feedback API" — but who triggers that feedback collection? If it's passive (users voluntarily submit), the signal will be sparse. Consider: after a session where multiple features were surfaced, include a one-question follow-up ("Was this helpful or too much?").

### What the Open Questions Signal

The four open questions are good ones, and their presence is a sign of a thoughtful spec author. Two of them (declined TTL, per-user state) should be resolved before Phase 1 ships. The other two (cross-agent discovery sync, negative discovery) are genuine design deferred items and can wait.

---

## Scalability Assessment

**Feature Count Scaling:** The registry is designed for a small-to-medium feature set (~10–30 features). The LLM evaluator prompt size is the primary constraint. At 30+ features, pre-filtering becomes mandatory. Plan for it.

**User Count Scaling:** This is local-first. Each agent instance serves a small number of users (1–5 typical). Multi-user isolation (see Critical Issue #1) is the key concern, not horizontal scale. The JSONL event log is appropriate for this scale — no need for a full database.

**Discovery Event Volume:** At 90-day retention and realistic surfacing frequency (a few events per session, a few sessions per week), the JSONL file grows slowly. A user with 3 sessions/week over 90 days with 3 events/session generates ~1,000 records — trivially small. Retention policy is appropriate.

**LLM API Dependency:** The evaluator introduces an external API call on session start. For local-first agents with intermittent connectivity, this must be non-blocking (see Critical Issue #2). Timeout budget for this call should be defined (suggested: 5 seconds max, fail open).

**Config Schema Coupling:** The registry auto-discovers features by iterating `InstarConfig` type. This creates tight coupling between the feature registry and the config schema. Schema changes to `InstarConfig` must now consider discovery implications. This is a manageable tradeoff — document it as an architectural constraint so future config changes don't inadvertently break discovery.

---

## Summary

This is a mature spec for a feature that fills a real gap in the instar platform. The problem statement is accurate, the design principles are defensible, and the implementation phases are sensibly ordered. The state machine is clean, the consent tier model is well-calibrated, and the agent behavioral contract gives implementors something concrete to work from.

The two critical issues — multi-user state isolation and LLM evaluator fallback — are solvable in Phase 1 design without rework. The recommendations are improvements, not corrections. The system as designed will work; the recommendations make it more robust and maintainable as it evolves.

**Proceed to implementation with the two critical issues resolved before Phase 1 code is written.**
