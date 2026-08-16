# Privacy & Ethics Review: Consent & Discovery Framework

**Review ID:** 20260321-232155
**Round:** 1
**Spec:** `specs/consent-discovery-framework.md`
**Reviewer Role:** Privacy & Ethics Specialist
**Date:** 2026-03-21

---

## Approval Status

**CONDITIONAL APPROVAL** — The framework demonstrates strong privacy intent and is well above average for an agent platform spec. However, several gaps must be addressed before implementation, particularly around data handling in the `DiscoveryContext` object, the `disabled` state's permanence, and the absence of explicit data minimization commitments. None of these are blockers by themselves, but together they represent meaningful risk.

---

## Research Findings

Before writing this review, I queried current GDPR guidance, AI ethics literature, dark pattern research, and privacy-by-design best practices. Key findings that informed this review:

**GDPR & Consent Law (2026):**
- Consent must be freely given, specific, informed, and unambiguous — no implied consent, no pre-checked boxes.
- Withdrawing consent must be as easy as giving it (ICO, gdpr-info.eu).
- Granular consent is required: users must be able to say yes to one data use and no to another. "All or nothing" is non-compliant in most EU/UK jurisdictions.
- Progressive disclosure (context-specific consent at the moment it becomes relevant) is now considered a best practice and is compliant with GDPR when implemented correctly.
- Bundled consent (one action covering multiple processing activities) is non-compliant.

**AI Agent Ethics:**
- Autonomous agents create a specific consent challenge: if the agent's behavior can evolve, meaningful consent is difficult because the AI itself may not know what it will do next.
- Constrained autonomy models — limiting decision boundaries while still allowing efficiency — are emerging as the ethical standard for agentic systems.
- Data minimization must be treated as a design constraint, not an afterthought.

**Dark Patterns & Consent Fatigue:**
- Even well-intentioned repeated consent prompts cause fatigue that undermines informed consent. The spec's `maxSurfacesBeforeQuiet` and cooldown mechanisms directly address this — a strength.
- "Roach motel" patterns (easy to enable, hard to disable) are a recognized dark pattern with regulatory enforcement consequences (Amazon: $2.5B, Google: €150M, TikTok: €345M).
- The `disabled` state in the spec — where "feature is never re-surfaced unless user asks" — must not become a roach motel in reverse (easy to decline permanently, hard to revisit).

**Privacy by Design:**
- Privacy should be the default state, not something users must configure.
- Data minimization: collect only what is necessary for the specific purpose.
- Transparency: users should understand what data is collected, who sees it, and for how long.
- The spec's `dataImplications: string[]` field and consent tier disclosures are positive implementations of these principles.

---

## Critical Issues

### 1. `DiscoveryContext` Sends Full User Message to LLM — Without Explicit Consent

**Severity: High**

The `DiscoveryContext` interface passes `userMessage: string` and `recentProblems: string[]` to the Haiku-class LLM evaluator. This means the full text of the user's conversation is being sent to an external model API (Anthropic) for classification purposes — **on every session start and on every problem detection event.**

The spec does not disclose this to users, does not obtain consent for it, and does not classify it under any consent tier. This is a data minimization failure: the full user message is more than what's needed for feature relevance classification. A hash, category label, or summarized intent would suffice.

**Recommendation:** Either (a) use only a category/intent label derived from the message rather than the raw message text, (b) classify this processing activity explicitly under the `network` consent tier (since data leaves the machine to Anthropic's API), and require user opt-in before enabling the context evaluator, or (c) run the evaluator only on-device if a local model is ever supported.

---

### 2. The `disabled` State Has No Recovery Path for Users Who Changed Their Mind

**Severity: Medium-High**

The state machine specifies: `disabled: Feature is never re-surfaced unless user asks.` This is correct as a default, but the spec provides no mechanism for users to browse previously-declined or disabled features and re-evaluate them. The only recovery path is `/capabilities`, which is pull-based — the user must already know to look there.

This creates an asymmetry: the system proactively surfaces features to undiscovered users, but users who disabled something must remember to pull. Over time, especially after a feature significantly improves, users are disadvantaged by their own earlier decision with no natural nudge to reconsider.

This is the inverse of a dark pattern — not manipulative, but potentially paternalistic. A user who disabled threadline six months ago and now has a use case for it is worse off than a new user who never saw it.

**Recommendation:** Add a periodic (e.g., quarterly) opt-in digest: "You have 3 features you've turned off. Want a quick summary of what's changed?" This is consent-respecting because it's periodic, low-pressure, and explicitly about previously-disabled features, not new ones. Also document the recovery path in AGENT.md and in the onboarding flow.

---

### 3. No Explicit Data Retention Policy for Discovery Events Beyond "90 Days"

**Severity: Medium**

The spec states discovery events are stored in `.instar/state/discovery-events.jsonl` with 90-day retention. However:

- There is no definition of what triggers deletion (rolling window? Last-write? Session close?).
- There is no mention of what happens to discovery state when a user asks to delete their data (right to erasure / CCPA deletion request).
- The `discoveryState` per feature per user is stored in `.instar/state/discovery/` with no retention policy specified at all. If a user disables a feature and then wants their data deleted, does discovery state get purged?
- In multi-user setups, there is no clear answer on which user's data maps to which records.

**Recommendation:** Define explicit retention triggers (rolling 90-day window by event timestamp). Add a `DELETE /features/discovery-data` endpoint or include discovery state in any existing user data deletion flow. Specify that discovery state is user-bound and gets purged on user removal.

---

### 4. `autonomous` Autonomy Profile Can Auto-Enable Features Without Consent

**Severity: Medium**

The spec states: "autonomous: Same as collaborative, but can auto-enable `informational` tier features."

Even `informational` tier features may have subtle effects the user is unaware of. Auto-enabling any feature without an explicit opt-in is a consent violation under GDPR's affirmative action requirement. The fact that a profile was previously set to `autonomous` does not constitute consent to future feature activations.

**Recommendation:** Auto-enabling features should require a one-time blanket consent at profile-selection time ("By setting this profile, you consent to the agent automatically enabling informational-tier features as they become relevant. You can review enabled features at any time via `/capabilities`."). This consent must be explicit, logged, and revocable by changing the autonomy profile.

---

## Recommendations

### R1. Classify the Context Evaluator as a Network-Tier Processing Activity

The LLM call that processes user messages sends data outside the machine. Register it as a feature in the Feature Registry with `consentTier: 'network'`, require opt-in before first use, and document what data leaves the machine (message text, recent problems, autonomy profile).

### R2. Add Explicit Data Minimization Documentation per Feature

The `dataImplications: string[]` field is good, but currently undefined in content. Add a schema requirement: each implication string must follow the format `[data type] → [where it goes] → [how long it's kept]`. This makes disclosures machine-readable and auditable.

### R3. Surface the Reversibility Note in All Consent Tiers, Not Just Activation Prompts

The spec only mandates reversibility notes in activation prompts. Awareness and suggestion messages should also include a one-liner: "Opt-in, reversible anytime." This reduces the psychological cost of even passive feature awareness.

### R4. Add a "Privacy Summary" Endpoint

`GET /features/privacy-summary` should return a user-facing plain-language summary of all data currently being collected, by which features, stored where, for how long. This supports GDPR's right to access and builds trust. It can be auto-generated from the `dataImplications` fields in the registry.

### R5. Define "Materially Changed Context" Objectively

The spec uses LLM judgment to determine when a declined feature's context has "changed materially enough" to re-surface it. This is subjective and could result in re-surfacing a feature the user clearly doesn't want. Define at least one objective gate: if a feature has been declined more than N times, it requires an explicit user-initiated query (pull-only) regardless of context evaluation.

### R6. Multi-User Isolation Must Be Explicit in Implementation, Not Just Assumed

Open Question 2 ("Per-user vs per-agent discovery state?") is flagged but deferred. This must be resolved before Phase 2 implementation. Sharing discovery state across users of the same agent is a privacy violation — if User A declined threadline and User B enabled it, User A's state should not be visible or inferred by User B.

---

## Observations

**Strengths:**

- The distinction between Awareness, Suggestion, and Activation pressure levels is sophisticated and directly maps to the GDPR "freely given" requirement. This is the right model.
- Graduated consent (lower-stakes features first, higher-stakes later) mirrors privacy-by-design principles and reduces information overload.
- Cooldown mechanisms and `maxSurfacesBeforeQuiet` are direct mitigations of consent fatigue — a known and well-documented risk. Their presence shows genuine user welfare consideration.
- `Transparent Reversibility` as a named design principle is above-average for an agent platform spec. The insistence on including "how to disable" in every activation prompt is best practice.
- The DON'T rule "don't surface features during time-sensitive or frustrating moments" reflects genuine user-welfare thinking that goes beyond legal compliance.
- The spec explicitly restricts `network` and `autonomous` tier features until the user has enabled at least one `local` tier feature. This graduated trust model is ethically sound.

**Concerns (Non-Critical):**

- The `consentTier: 'informational'` label is slightly misleading. "Informational" suggests no data implications, but a file viewer or dashboard theme still involves user behavior being tracked (for discovery state purposes). Consider renaming to `'preference'` to be more accurate.
- Success Criterion 3 ("Feature enable rate > 30% for contextual suggestions") creates a subtle incentive misalignment. Optimizing for enable rate could pressure future developers to make suggestions more persuasive rather than more accurate. Consider replacing with an accuracy metric: "Percentage of enabled features still active after 30 days."
- The spec does not address what happens if an agent is transferred between users (e.g., an instar agent is reassigned). Does discovery state travel with the agent or reset? Stale discovery state from a prior user could surface inappropriate features to a new user.
- No mention of age verification or parental consent for minor users. If instar ever serves minors, the graduated discovery framework alone is insufficient.

---

## AI-Specific Ethics Assessment

The spec navigates the core tension in agentic consent well: agents need some autonomy to be useful, but that autonomy must not override user sovereignty. The autonomy profile integration is the right architectural decision — it lets users set their own tolerance for agent initiative rather than having it hardcoded.

One underexplored area: **agent data sovereignty.** Open Question 3 ("Discovery across agents?") raises but doesn't resolve whether an agent can share awareness of what a user has enabled on a different agent. From an ethics standpoint, discovery state is personal data — it reveals what a user knows, what they've declined, and indirectly, what they distrust. This should not cross agent boundaries without explicit consent from both user and agents involved.

The framework also does not address what an agent should do if it believes a feature would significantly benefit a user who has explicitly declined it. The current design says: respect the decline. That is the correct answer. But it should be stated explicitly as a principle — not just as an implicit consequence of the state machine — so future implementers don't rationalize overriding it.

---

## Regulatory Compliance Assessment

| Regulation | Status | Notes |
|------------|--------|-------|
| GDPR (EU) | Partial | Context evaluator data flow needs classification. Right to erasure not addressed for discovery state. Granular consent for multi-processing activities needs explicit confirmation. |
| UK GDPR | Partial | Same as GDPR. ICO guidance on "freely given" consent is satisfied by pressure-tier design. |
| CCPA (California) | Partial | No mention of data sale prohibition or opt-out rights. Likely not applicable to current instar model, but should be confirmed. |
| EU AI Act | Low risk | Discovery framework is not a high-risk AI system per Act definitions. No biometric, employment, or credit scoring. |
| COPPA / Age reqs | Not addressed | If minor users are ever in scope, current framework is insufficient. |

---

## Scalability Assessment

The framework scales reasonably well architecturally. The FeatureRegistry + state machine pattern is standard and maintainable. Haiku-class LLM cost for context evaluation is negligible at any individual-user scale.

**Privacy scalability concerns:**

- As the feature inventory grows, `dataImplications` fields will become increasingly important for auditability. Without enforcement on their format and content, they will become free-form strings that are meaningless for compliance purposes.
- Discovery event logs at 90-day retention across many users and features could become a significant data store. The spec should specify log compression and whether these logs are included in backup/sync (currently unspecified).
- The `DiscoveryContext.eligibleFeatures` list grows with the feature inventory. Sending increasingly large feature registrations to an LLM evaluator on every session start will eventually become both slow and expensive. Define a ceiling (e.g., max 20 eligible features evaluated per call) and a pruning strategy.

---

## Score

**7.5 / 10**

The framework is thoughtful, user-welfare-oriented, and architecturally sound. The consent tier model, graduated discovery, and pressure-level distinctions are genuinely good design. The score is held back by the unresolved LLM data flow issue (Critical Issue 1), the absence of right-to-erasure handling, and the auto-enable behavior on the `autonomous` profile. None of these are fatal — they are fixable in Phase 1 before any user data is collected. Address Critical Issues 1–4 and Recommendations R1–R3 before Phase 2 begins.

---

*Review generated by Echo (privacy & ethics review pass) — 2026-03-21*
