# SpecReview Synthesis: Consent & Discovery Framework

**Review ID**: 20260321-232155
**Date**: 2026-03-21
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX/API, Marketing
**Spec**: specs/consent-discovery-framework.md

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 6.75 / 10
**Score Range**: 5.0 - 8.0

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | Conditional | 5/10 | LLM evaluator prompt injection (raw userMessage passed to Haiku) is a critical attack surface; unauthenticated endpoints expose full feature catalog |
| Scalability | Conditional | 6/10 | JSONL-only persistence lacks materialized state for cooldown queries; LLM evaluator has no cost ceiling or deduplication |
| Business | Approved w/ Conditions | 7.5/10 | Genuine whitespace — no competitor does LLM-evaluated contextual feature surfacing; multi-user state is unresolved and blocks commercial viability |
| Architecture | Approved w/ Conditions | 8/10 | Clean state machine, narrow integration surface; LLM evaluator has no fallback contract and multi-user isolation is unresolved |
| Privacy | Conditional | 7.5/10 | DiscoveryContext sends raw user messages to external LLM without consent disclosure; no right-to-erasure path for discovery data |
| Adversarial | Not Approved | 5/10 | Behavioral contracts are not enforced server-side; state API allows direct writes bypassing transition logic; activation prompt template is a dark pattern |
| DX / API | Conditional | 7.5/10 | No error response schema; `/features/discoverable` has routing collision with `:id`; `POST /features/:id/state` conflates replacement with transition |
| Marketing | Conditional | 7.5/10 | Name "Consent & Discovery Framework" conflates two concerns and sounds like GDPR tooling; the discovery/push layer is the novel contribution and it's buried |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

### 1. Multi-User Discovery State Isolation Is Unresolved (7/8 reviewers)
Every reviewer except Marketing flagged Open Question #2 as requiring resolution before implementation. Per-agent state (the current default path) causes cross-user consent violations — User A's decisions affect User B. The consensus is unanimous: scope state as `(userId, featureId)` from day one. **This is the single most agreed-upon issue across all reviews.**

### 2. LLM Evaluator Receives Raw User Input — Prompt Injection Surface (4/8 reviewers)
Security, Privacy, Adversarial, and Architecture all identified that passing `userMessage` directly to the Haiku evaluator creates an injection surface. Security and Adversarial rated this Critical/P0. Privacy noted it also constitutes an undisclosed data flow to an external API.

### 3. `declined → aware` Transition via LLM Judgment Is Under-Specified and Gameable (5/8 reviewers)
Security, Business, Privacy, Adversarial, and Architecture flagged that "context changes materially" has no operationalized definition. The LLM decides freeform whether to override a user's explicit decline. Security noted GDPR Article 7 risks. Adversarial demonstrated it can be gamed via crafted conversation topics.

### 4. No Evaluator Rate Limiting or Cost Ceiling (4/8 reviewers)
Security, Scalability, Adversarial, and DX all noted that `POST /features/evaluate-context` has no rate limit, no caching, and no deduplication. At scale this becomes a denial-of-wallet vector and a cost driver.

### 5. State Machine Transitions Not Enforced Server-Side (4/8 reviewers)
Security, Adversarial, DX, and Architecture identified that `POST /features/:id/state` allows direct state writes with no transition validation. The state machine diagram describes conceptual transitions but the API bypasses them entirely.

### 6. LLM Evaluator Has No Fallback for Unavailability (3/8 reviewers)
Architecture, Scalability, and Adversarial noted that when the Haiku API is down, the spec defines no behavior. For a local-first system, this must degrade gracefully to "surface nothing" rather than blocking session start.

### 7. Feature Count Growth Will Degrade Evaluator Quality and Cost (4/8 reviewers)
Security, Scalability, Architecture, and DX flagged that `eligibleFeatures` grows with the registry. At 30-50+ features, the Haiku evaluator prompt becomes unwieldy. A pre-filter or max-features-per-evaluation cap is needed.

### 8. `autonomous` Profile Auto-Enabling Features Without Explicit Consent (3/8 reviewers)
Security, Privacy, and Adversarial flagged that auto-enabling even `informational` tier features violates affirmative consent requirements. Adversarial additionally identified a naming collision between the `autonomous` autonomy profile and the `autonomous` consent tier.

---

## Critical Issues (Blockers)

*Any reviewer issuing BLOCK status — these must be addressed before proceeding.*

The Adversarial reviewer issued NOT APPROVED. Security issued CONDITIONAL — DO NOT IMPLEMENT AS WRITTEN. Combined with consensus findings, the following are blockers:

| # | Issue | Reviewers | Severity | Suggested Fix |
|---|-------|-----------|----------|---------------|
| B1 | Raw `userMessage` passed to LLM evaluator enables prompt injection | Security, Adversarial, Privacy | Critical/P0 | Sanitize input (pass topic summary, not raw text); validate evaluator output against registry; structural delimiter between system prompt and user content |
| B2 | `/features/*` endpoints have no authentication specified | Security, Adversarial | Critical/P0 | All endpoints require Bearer token; document explicitly in spec |
| B3 | `POST /features/:id/state` allows arbitrary state writes | Security, Adversarial, DX | Critical/P0 | Enforce valid transitions server-side; reject invalid transitions with 400/422; require consent evidence for `enabled` writes |
| B4 | Multi-user discovery state isolation unresolved | All except Marketing | High (architectural) | Key all state as `(userId, featureId)`; add `userId` to DiscoveryEvent schema; resolve before Phase 1 |
| B5 | `declined → aware` transition governed by unoperationalized LLM judgment | Security, Business, Adversarial, Privacy, Architecture | High | Replace with deterministic criteria (topic classification change, N days elapsed, feature version change, or explicit user re-inquiry) |
| B6 | Behavioral contracts are not enforced server-side | Adversarial | High | Every behavioral rule that currently lives in AGENT.md must be asked "can this be enforced by the server?" — if yes, enforce it |

---

## Conflicts

*Points where reviewers disagree or provide contradictory recommendations.*

### 1. JSONL vs SQLite for State Storage
- **Scalability** strongly recommends SQLite for discovery state (materialized state with indexed queries), keeping JSONL only for the event audit log.
- **Architecture** says JSONL event log is "appropriate for this scale" and "no need for a full database."
- **Resolution**: Scalability's argument is stronger. Instar already uses SQLite for `topic-memory.db` and `semantic.db`. A `discovery.db` follows established patterns. Use SQLite for state, JSONL for audit trail.

### 2. Whether the Activation Prompt Template Is a Dark Pattern
- **Adversarial** labels the activation prompt ("Based on what we've been working on... Want me to enable it?") as structurally identical to documented dark patterns (manufactured obligation, benefit-before-cost, anthropomorphic pressure).
- **Architecture** and **Business** praise the surfacing templates as "excellent DX documentation" and "practical and immediately actionable."
- **Resolution**: Both are partially right. The template content is good (concrete, usable) but the framing structure should be revised per Adversarial's recommendation: lead with information, not obligation. Remove "Want me to..." phrasing.

### 3. Whether `informational` Tier Auto-Enable Is Acceptable
- **Architecture** and **Scalability** treat the `autonomous` profile auto-enabling `informational` features as acceptable.
- **Privacy** and **Adversarial** flag it as a consent violation requiring at minimum a blanket opt-in at profile-selection time.
- **Resolution**: Privacy's position is stronger. Even low-stakes features should require a logged consent event. Auto-enable should log an event and be visible in the dashboard.

### 4. `disabled` State — Appropriately Final vs. User-Disadvantaging
- **Architecture**, **Marketing**, and **Adversarial** praise the `disabled` state's finality as a trust commitment.
- **Privacy** flags that users who disabled features have no natural path to learn they've improved, creating an asymmetry where new users are better served than returning users.
- **Resolution**: Both are correct. Keep `disabled` as terminal for proactive surfacing. Add Privacy's recommendation: an optional periodic digest ("You have N disabled features — want a summary of what's changed?").

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|------------------|--------|--------|
| P0 | Sanitize `userMessage` before passing to evaluator; validate evaluator output against registry | Security, Adversarial, Privacy | Small | Critical — eliminates primary injection vector |
| P0 | Require Bearer auth on all `/features/*` endpoints | Security, Adversarial | Trivial | Critical — prevents enumeration attacks |
| P0 | Enforce state machine transitions server-side with 400/422 on invalid transitions | Security, Adversarial, DX | Medium | Critical — prevents consent bypass |
| P1 | Resolve multi-user state keying as `(userId, featureId)` before Phase 1 | All reviewers | Small | High — prevents architectural migration debt |
| P1 | Operationalize "context changed materially" with measurable criteria | Security, Business, Adversarial, Privacy | Medium | High — prevents consent reversal abuse |
| P1 | Define LLM evaluator fallback (degrade to "surface nothing") | Architecture, Scalability, Adversarial | Small | High — prevents session-start blocking |
| P1 | Rate-limit evaluator: max N calls/session, min interval, cache results | Security, Scalability, Adversarial | Small | Medium — prevents cost amplification |
| P1 | Rename `POST /features/:id/state` to `POST /features/:id/transition` with validated transitions | DX, Security | Small | Medium — clarifies semantics, enables validation |
| P1 | Add error response schema for all endpoints | DX | Small | Medium — agents cannot self-correct without error legibility |
| P1 | Server-side consent verification for `autonomous`/`network` tier activation | Security, Privacy | Medium | High — behavioral contract alone is insufficient |
| P2 | Use SQLite for discovery state, JSONL for audit log | Scalability | Medium | Medium — prevents degradation at scale |
| P2 | Split `FeatureRegistration` into static `FeatureDefinition` + dynamic `FeatureState` | Architecture, Scalability | Small | Medium — cleaner caching and evolution |
| P2 | Add `validTransitions` field to `GET /features/:id` response | DX | Trivial | Medium — agents plan before acting |
| P2 | Fix `/features/discoverable` routing collision; use query params instead | DX | Small | Medium — prevents latent routing bug |
| P2 | Add "deferred" discovery state for "remind me later" | Architecture | Small | Medium — improves signal quality of `declined` |
| P2 | Define max features per evaluator call (8-10) with pre-filter | Architecture, Scalability, DX | Small | Medium — keeps evaluation quality stable |
| P2 | Revise activation prompt template to remove dark pattern structure | Adversarial | Trivial | Medium — fixes consent quality |
| P2 | Classify context evaluator as a `network`-tier processing activity | Privacy | Small | Medium — discloses data flow to external API |
| P2 | Add right-to-erasure path for discovery data | Privacy | Small | Medium — GDPR compliance |
| P3 | Rename framework for user-facing contexts (rec: "Feature Compass" or "Discovery Protocol") | Marketing | Trivial | Low — better positioning |
| P3 | Add `GET /features/summary` lightweight endpoint | DX | Trivial | Low — reduces payload on session start |
| P3 | HMAC-sign discovery event log entries | Adversarial | Small | Low — prevents consent history forgery |
| P3 | Add negative discovery to Phase 5 scope | Business, Scalability, Marketing | Medium | Low — reduces feature bloat long-term |
| P3 | Distinguish `ignored` from `declined` in state machine | Adversarial | Small | Low — prevents false-negative classifications |

---

## Scalability Summary

| Phase | Rating | Key Risk | Recommendation |
|-------|--------|----------|----------------|
| Phase 1: Feature Registry | 8/10 | Low. Static config wiring. | Ship as-is after resolving multi-user keying. |
| Phase 2: Discovery State Machine | 5/10 | High. JSONL-only persistence degrades on cooldown queries. Multi-user schema undefined. | Use SQLite for state store. Define `(userId, featureId)` schema. |
| Phase 3: Context Evaluator | 6/10 | Medium. No cost ceiling, no rate limit, no caching, no fallback. | Add rate limiting, result caching, graceful degradation, input sanitization. |
| Phase 4: Agent Integration | 9/10 | Low. Template and doc updates. | No scaling concerns. |
| Phase 5: Observability | 7/10 | Medium. Analytics over JSONL will be slow at scale. | Pre-aggregate metrics or use SQLite before this phase. Define analytics schema in Phase 2. |

**Viral spike (1,000 agents in 1 hour):** Feature registry handles trivially. Evaluator hits Anthropic rate limits but degrades gracefully if fallback is defined. JSONL concurrent writes risk race conditions — SQLite in WAL mode handles this safely. Cost: ~$2 for the spike.

---

## Gaps

*Areas that no reviewer adequately covered:*

1. **Feature deprecation/removal lifecycle** — The spec explicitly excludes sunsetting, but no reviewer addressed what happens when a feature is removed from the registry while users have it in various discovery states. Feature ID reuse after deletion (noted only briefly by Adversarial) could cause consent state inheritance.

2. **Testing strategy** — No reviewer addressed how the behavioral contract, state machine transitions, or evaluator accuracy would be tested. The spec has no test plan and no reviewer requested one.

3. **Migration path from current state** — Existing agents have features that users have already enabled or discovered informally. No reviewer addressed how current feature state is bootstrapped into the new registry (does everything start as `undiscovered`? `enabled`?).

4. **Compaction interaction** — The spec notes agents lose context on compaction. No reviewer analyzed whether post-compaction agents would correctly resume discovery state or might re-surface features inappropriately.

5. **Offline/local-only operation** — While Architecture noted the evaluator needs a fallback, no reviewer fully analyzed the framework's behavior when running permanently offline (no Haiku API access at all).

6. **Accessibility** — No reviewer assessed whether the conversational surfacing templates are accessible to users with different communication needs or preferences.

---

## Name Analysis (from Marketing Reviewer)

**Current name:** "Consent & Discovery Framework" — accurate but sounds like GDPR tooling. Leads with the less differentiated half (consent). "Framework" is generic.

**Recommended alternatives:**

| Name | Best For | Strengths |
|------|----------|-----------|
| **Feature Compass** | User-facing language, agent conversation, dashboard | Memorable, metaphor-friendly ("compass orients without directing"), natural in agent speech |
| **Discovery Protocol** | Technical docs, API design, internal naming | Clean, lowercase-friendly, echoes MCP naming, signals structure |
| **Contextual Surfacing Engine** | Engineering conversations | Technically precise, good acronym (CSE) |
| **Opt-In Intelligence** | User explanations, onboarding | Reclaims positive framing of opt-in |
| **Ambient Intelligence Layer** | Architecture docs | Positions push-based discovery as novel contribution |

**Marketing recommendation:** Use "Feature Compass" for user-facing contexts, "Discovery Protocol" for technical docs, keep "Consent & Discovery Framework" as the formal spec title only.

**10-second explainer (draft):** "Instar knows when a feature would help you before you know to ask for it. It mentions it once, at the right moment, without pressure — and tells you exactly how to turn it off."

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviews completed | 8 / 8 |
| Approvals (unconditional) | 0 |
| Conditional approvals | 6 |
| Not approved | 1 (Adversarial) |
| Conditional — do not implement as written | 1 (Security) |
| Score standard deviation | 1.09 |
| Issues raised by 3+ reviewers | 8 |
| Unique critical/P0 issues | 6 |
| Conflicting recommendations | 4 |

**Convergence Assessment: CONVERGING**

Reviewers broadly agree on the framework's conceptual strength and on the specific gaps. The two lowest scores (Security 5, Adversarial 5) identify enforcement gaps rather than design failures — the principles are praised universally, but the gap between behavioral intent and system enforcement is the central theme. The six highest-priority fixes (P0 items) are straightforward engineering work, not redesigns.

The spec needs a focused revision pass addressing P0 and P1 items before implementation begins. No architectural rethink is required.

---

## Next Steps

- [ ] **Spec revision (P0 blockers):** Address all 6 blockers before any code is written. Estimated: 1-2 hours of spec revision.
  - [ ] Define input sanitization for evaluator (no raw `userMessage`)
  - [ ] Specify auth requirements for all `/features/*` endpoints
  - [ ] Define server-side transition validation for state machine
  - [ ] Resolve multi-user state keying as `(userId, featureId)`
  - [ ] Operationalize "context changed materially" with measurable criteria
  - [ ] Add evaluator fallback contract (degrade to "surface nothing")
- [ ] **Spec revision (P1 items):** Address before Phase 2 implementation begins.
  - [ ] Add rate limiting and caching spec for evaluator
  - [ ] Rename state endpoint to `transition` with error schema
  - [ ] Define error response schema for all endpoints
  - [ ] Specify server-side consent verification for high-tier activation
- [ ] **Architecture decision:** SQLite for state, JSONL for audit trail. Document before Phase 2.
- [ ] **Naming decision:** Choose user-facing name before Phase 4 (AGENT.md integration).
- [ ] **Round 2 review:** After spec revision, re-review with Security and Adversarial reviewers to confirm P0 items are resolved. Target score: 7+ across all reviewers.
- [ ] **Baseline metrics:** Instrument current feature adoption rates before Phase 1 ships, so Phase 5 analytics have a comparison point.
