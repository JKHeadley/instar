# Adversarial Review: Round 2

**Spec:** `specs/consent-discovery-framework.md` (Rev 2 — post-review)
**Reviewer Role:** Adversarial / Red Team
**Review Date:** 2026-03-21
**Round:** 2 (following Round 1 NOT APPROVED at 5/10 security posture, 7.2/10 overall)

---

## Round 1 Issue Resolution

| Issue | Round 1 Priority | Status | Assessment |
|-------|-----------------|--------|------------|
| LLM evaluator receives raw `userMessage` — prompt injection surface | P0 | **RESOLVED** | Input now sanitized to `topicCategory` (categorical label) and `problemCategories` (structured labels). No raw user text reaches the evaluator. Output validated: `featureId` must exist in `eligibleFeatures`, `surfaceAs` capped by autonomy profile. Structural delimiters added. |
| `POST /features/:id/state` allows direct state injection bypassing transition guards | P0 | **RESOLVED** | Renamed to `POST /features/:id/transition`. Server-side valid transitions table enforced. Invalid transitions return 422 with valid alternatives. Consent record required for `network`/`self-governing` → enabled. |
| `declined → aware` gated on free-form LLM judgment — gameable | P1 | **RESOLVED** | Now uses deterministic criteria: topic category change + N days elapsed OR feature version change OR explicit user re-inquiry. "Server checks, not caller's claim." No LLM judgment involved in this transition. |
| `autonomous` naming collision between autonomy profile and consent tier | P1 | **RESOLVED** | Consent tier renamed to `self-governing`. Autonomy profile retains `autonomous`. Note added explicitly: "intentionally named differently to prevent semantic collision." |
| Graduated trust prerequisites were behavioral-only | P1 | **RESOLVED** | Pre-filter now server-enforced: `network`/`self-governing` tier features excluded if no `local` tier feature is enabled. This is in the pre-filter pipeline, not just agent instructions. |
| No rate limiting on evaluator — denial-of-wallet | P1 | **RESOLVED** | `maxCallsPerSession: 3`, `minIntervalMs: 300000` (5 min), `resultCacheTtlMs: 600000` (10 min) caching by topic, `timeoutMs: 5000`. Explicit `EvaluatorLimits` interface. |
| Multi-user state isolation deferred | P1 | **RESOLVED** | `(userId, featureId)` primary key in SQLite from day one. Single-user defaults to `"default"`. Multi-user derives from authenticated session. |
| Activation prompt was a dark pattern | P1 | **RESOLVED** | Revised templates: info before benefits, neutral phrasing ("let me know if"), data implications disclosed before value proposition, no "Want me to..." anthropomorphic pressure. Explicit design principles documented. |
| `maxSurfacesBeforeQuiet` not persisted across sessions | P1 | **RESOLVED** | `surfaceCount` is a field on `FeatureState` in SQLite — persisted per `(userId, featureId)`, not in-memory. Survives session boundaries. |
| No authorization on `/features/*` endpoints | P0 (security) | **RESOLVED** | "All `/features/*` endpoints require Bearer token authentication." 401 on unauthenticated requests. Documented explicitly. |
| Evaluator has no fallback contract | P1 | **RESOLVED** | Fail-open: if API unavailable, "no proactive surfacing for this session." Pull path (`/capabilities`) remains functional. 5s timeout. Malformed output → log + surface nothing. |

---

## New Attack Vectors (Introduced by Revisions)

### 1. `declined → aware` Re-Inquiry Criterion Remains Trivially Exploitable

**Likelihood: High | Impact: Medium | Priority: P1**

The deterministic criteria for `declined → aware` include: "The user explicitly re-inquires about capabilities ('what else can you do?')."

This is still gameable. A user who was told about threadline and declined can say "what else can you do?" at any point and the `declined` state is reset to `aware` — regardless of how many times they have already declined or how recently. There is no cooldown on this specific criterion, no floor time after a re-inquiry reset, and no cap on how many times re-inquiry can trigger the transition.

**Attack sequence:**
1. Feature X is surfaced → user declines → `declined`
2. User says "what else can you do?" → `declined → aware` (legitimate trigger)
3. Feature X is surfaced again → user declines again → `declined`
4. Repeat indefinitely at will

The spec has no `maxDeclines` count, no `permanently-quiet` state, and no guard against this cycle. My Round 1 recommendation for a `permanently-quiet` state after N declines was not adopted.

**The fix I recommended but did not see in Rev 2:** After N declines of the same feature (suggest N=3), the re-inquiry criterion should NOT reset `declined → aware` for that specific feature. The user would need to explicitly name the feature to re-enter discovery.

---

### 2. Topic Category Change Criterion Creates an Indirect Escape Hatch

**Likelihood: Medium | Impact: Medium | Priority: P1**

The `declined → aware` transition fires when "The user's conversation topic has changed to a different category (as classified by the evaluator's topic taxonomy)."

A sophisticated user who knows the taxonomy (or discovers it through trial and error) can deliberately steer the conversation into a different topic category for a single message, triggering the re-surface, then return to their original work. The spec doesn't require the topic to remain changed for any duration — just that it changed.

More concerning: the topic classification itself is done by the evaluator using the same Haiku-class LLM. While raw user messages are no longer passed to the evaluator, topic classification still depends on conversation inference. If the topic extraction system is itself LLM-based (unclear from the spec), there may be an indirect injection surface: user shapes the conversation to produce a specific topic label, which then unlocks a state transition.

**The spec doesn't address:** How topic category is extracted. Is this a separate LLM call, a regex/keyword classifier, or the same evaluator? If LLM-based, the sanitization story for topic extraction needs the same rigor as the evaluator itself.

---

### 3. `consentRecord` Is Caller-Supplied — No Content Validation Specified

**Likelihood: Medium | Impact: High | Priority: P1**

`POST /features/:id/transition` for `→ enabled` on `network`/`self-governing` tiers requires a `consentRecord`. The spec validates that a `consentRecord` is **present** — but does not specify validation of its **content**.

The `ConsentRecord` structure contains:
- `mechanism: 'explicit-verbal' | 'explicit-written' | 'profile-blanket'`
- `dataImplications: DataImplication[]` — what was disclosed
- `consentedAt: string` — ISO timestamp

**Attack scenario:** An automated client (or a misbehaving agent post-compaction) constructs a `consentRecord` with:
- `mechanism: 'explicit-verbal'` (no verification possible)
- `dataImplications: []` (empty — nothing disclosed)
- `consentedAt: "2020-01-01T00:00:00Z"` (backdated)

The server has no way to verify the `consentedAt` timestamp is recent, that the `dataImplications` actually match the feature's defined implications, or that any verbal consent actually occurred. The consent record is an attestation, not a cryptographic proof — but the spec treats it as sufficient for high-tier activation.

**Minimum required fix:** Server should validate that `consentRecord.dataImplications` matches the feature definition's `dataImplications` (at least by count and `dataType`). A backdated `consentedAt` (> N minutes in the past) should be rejected. These are not cryptographic proofs, but they at least prevent lazy bypass.

---

### 4. `surfaceAs: 'prompt'` Guard for `self-governing` Tier Has a Gap

**Likelihood: Low | Impact: Medium | Priority: P2**

The spec states: "`surfaceAs: 'prompt'` is rejected for `self-governing` tier features (activation requires explicit user-initiated flow)."

This means the evaluator cannot auto-generate activation prompts for `self-governing` features. But the spec does not block the agent from constructing and delivering such a prompt through its behavioral layer, bypassing the evaluator entirely.

The agent could, through behavioral instructions (AGENT.md or a skill), directly invoke the activation template for a `self-governing` feature without going through the evaluator. The evaluator guard only prevents the LLM from *recommending* a prompt — it does not prevent the agent from *delivering* one directly.

**Mitigation exists but is incomplete:** The transition endpoint requires a `consentRecord` for `→ enabled`, so even if the agent delivers an unsanctioned prompt, the user still must consent before the feature enables. The damage is limited to an improperly pressured activation prompt, not an unauthorized enable. This is a P2, not a blocker.

---

### 5. `DELETE /features/discovery-data` Scope Is Unspecified

**Likelihood: Low | Impact: Medium | Priority: P2**

The spec adds `DELETE /features/discovery-data` for right-to-erasure. But the scope is undefined:
- Does it delete state for all features for a `userId`?
- Does it also delete consent records? (The spec says "Consent records are never automatically deleted — they serve as proof of consent.")
- What happens to `DiscoveryEvent` entries in the JSONL audit log?

If `DELETE /features/discovery-data` deletes `FeatureState` but not `DiscoveryEvent` JSONL entries, the user's interaction history persists in the audit log even after they requested erasure — which is a GDPR compliance gap. If it does delete JSONL entries, the audit trail has gaps that make consent record integrity questionable.

**The spec sets up a conflict it doesn't resolve:** Consent records are "never automatically deleted" (compliance), but GDPR gives users the right to erasure. These requirements are in direct tension. The spec acknowledges neither side of this tension.

---

### 6. Evaluator Bootstrapping: `enabled` Features Included in `eligibleFeatures` Pre-Filter?

**Likelihood: Medium | Impact: Low | Priority: P2**

The pre-filter excludes features where `discoveryState` is `disabled`, `enabled`, or `deferred` (with active cooldown). This is correct. But the pre-filter description says "Filter by category match against `topicCategory`" — and nowhere does the spec say already-enabled features are excluded from `GET /features/evaluate-context` context entirely.

If the evaluator receives features in `enabled` state in `eligibleFeatures`, it might recommend surfacing them again ("you have X enabled, which is relevant here") — which would increment `surfaceCount` and potentially trigger cooldown behavior for an already-enabled feature. The pre-filter at step 1 says exclude `enabled`, so this should be fine — but the pre-filter description is ambiguous about whether `enabled` exclusion is pre-LLM or just in the output validation pass.

Minor clarity issue but worth flagging given the LLM's tendency to reason about the full eligible set.

---

### 7. Discovery Event Log HMAC Signing Not Adopted

**Likelihood: Low | Impact: Low | Priority: P3**

My Round 1 P3 recommendation — HMAC-sign discovery event log entries — was not addressed. The audit log (`discovery-events.jsonl`) is append-only but not tamper-evident. An attacker with write access to the `.instar/` directory (e.g., via a compromised process) could retroactively modify consent records or surfacing history.

This remains a P3. The consent records in SQLite are harder to forge than JSONL entries, but the JSONL audit trail is the human-readable compliance record. It should be signed.

---

## Remaining Concerns

### Most Concerning: No `permanently-quiet` State

The absence of a `permanently-quiet` state (recommended in Round 1) means the spec has no upper bound on how many times a user can be re-cycled through `declined → aware` for a given feature. The `maxSurfacesBeforeQuiet` field addresses how many times a feature is surfaced *before engagement* — but the "re-inquiry" and "topic change" escape hatches reset this cycle indefinitely.

A user who sincerely never wants a feature can be subjected to unlimited re-surfacing attempts as long as they occasionally ask "what else can you do?" or switch topics. This directly violates the spirit (though not the letter) of the design principles.

### Moderately Concerning: Topic Extraction Pipeline Opacity

The spec specifies that `topicCategory` is a "categorical label, not free text" extracted from the conversation. But it does not specify *how* this extraction happens. If the extraction is LLM-based, it re-introduces a weaker version of the injection surface that was eliminated from the evaluator. The topic extraction system needs the same sanitization analysis.

### Minor: `disabled` State Re-Discovery Path Still Underspecified

My Round 1 observation: "there is no guidance on what 'user asks' looks like in the discovery flow" for `disabled` features. Rev 2 adds this to the spec: "users can always re-discover it via `/capabilities` or by explicitly asking." This is an improvement, but "by explicitly asking" is still not specified behaviorally — what phrasing triggers re-discovery? Is the agent supposed to watch for this? Or is it purely pull-based via `/capabilities`?

---

## Overall Assessment

Rev 2 is a materially stronger spec than Rev 1. The six P0 blockers I identified (directly or in combination with Security and other reviewers) are all resolved cleanly. The fixes are genuine — not cosmetic. The injection surface is closed. The state machine is enforced. Multi-user isolation is built in from day one. The activation prompt is no longer a dark pattern.

**Did the fixes just move the attack surface?**

Partially. The primary injection vector (raw user message to LLM) was closed, but two indirect channels remain open:
1. The "re-inquiry" escape hatch in `declined → aware` is still exploitable (though now requires deliberate user action rather than passive message content)
2. The topic extraction pipeline, if LLM-based, may re-introduce a weaker version of the same injection risk

The `consentRecord` validation gap is the most concerning new issue introduced by the revisions — the fix for "require consent record" didn't specify what makes a consent record valid. This is an implementation-time trap.

**The enforcement gap from Round 1 is substantially closed.** The spec now distinguishes server-enforced from agent-behavioral rules with explicit labels. The critical transitions are enforced at the API layer. The evaluator is bounded, cached, and rate-limited.

What remains are hardening issues, not architectural gaps. The spec is implementable as written — but implementations will need to make judgment calls about consent record validation and topic extraction that the spec leaves underspecified.

---

## Approval Status: CONDITIONAL APPROVE

The spec may proceed to Phase 1 implementation. Before Phase 2 (State Machine) ships:
1. Add a `permanently-quiet` state (or a `maxDeclines` floor) to close the re-inquiry cycle exploit
2. Specify topic extraction pipeline — confirm it does not reintroduce injection surface
3. Specify `consentRecord` content validation (timestamp recency check, `dataImplications` matching)

These are not blockers for Phase 1 (Feature Registry). They must be resolved before the state machine and consent recording go live.

## Score: 7.5 / 10

| Dimension | Score | Change | Notes |
|-----------|-------|--------|-------|
| Problem definition | 9/10 | — | Unchanged, excellent |
| Architecture | 8/10 | +1 | State machine enforcement closes the primary architectural gap |
| Security posture | 7/10 | +2 | Injection surface closed; consent record validation gap and re-inquiry cycle are the remaining concerns |
| Consent model | 8.5/10 | +0.5 | Tiered consent + deterministic transitions is now solid; missing `permanently-quiet` state is the main gap |
| Implementation clarity | 8/10 | — | Enforcement classification (server vs behavioral) is a significant improvement |
| Scalability | 8/10 | +1 | SQLite from day one, rate limiting, pre-filter, caching all addressed |
| Observability | 7/10 | — | Phase 5 scope is good; HMAC signing of audit log still missing |

## Score Delta: +0.3 from Round 1 (7.2 → 7.5 overall; security posture 5 → 7)

The score improvement is real but bounded — the spec is significantly safer than Rev 1, but the re-inquiry exploit and consent record validation gap prevent a higher score. Resolving those three items before Phase 2 would warrant 8.5+.
