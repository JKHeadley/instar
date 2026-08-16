# Business Strategy Review: Consent & Discovery Framework

**Spec:** `specs/consent-discovery-framework.md`
**Review ID:** 20260321-232155
**Round:** 1
**Reviewer Role:** Business Strategy & Product-Market Fit
**Date:** 2026-03-21

---

## Approval Status

**APPROVED WITH CONDITIONS**

The core concept is sound and addresses a genuine problem in the agent infrastructure space. The framework's principles are well-reasoned and the phased implementation is realistic. Conditions relate to market positioning clarity and the unresolved multi-user/multi-agent questions that affect commercial viability.

---

## Score: 7.5 / 10

Strong fundamentals, under-explored monetization angle, one structural gap around multi-user state that could constrain future commercial growth.

---

## Research Findings

### Competitive Landscape

**Traditional Consent Management Platforms (CMPs)** — OneTrust, Usercentrics, Ketch, Securiti — operate in a GDPR/CCPA compliance frame. They manage cookie consent and data processing agreements, not feature discovery. Ketch recently introduced "Progressive Consent" (step-by-step permission collection as users engage), which is conceptually adjacent to this spec's graduated consent approach. However, none of these platforms address the agent-feature-surfacing problem. They are regulatory tools, not UX intelligence tools.

**Feature Flag Platforms** — LaunchDarkly, Statsig, Growthbook handle progressive rollouts from the *developer/operator* side. They gate features at the infrastructure level by user cohort or percentage. They do not give the AI agent itself awareness of what features exist, or decision-making capability about when to surface them conversationally. No feature flag platform has a concept equivalent to `DiscoveryState` or LLM-evaluated contextual triggering.

**Progressive Disclosure in AI Agent Contexts** — This is an emerging pattern. Claude-Mem (docs.claude-mem.ai) documents progressive disclosure as a context management strategy: load only skill metadata at startup, fetch full content on demand. The Towards AI publication covered "Progressive Disclosure in AI Agent Skill Design" in 2025. AGNTCY (launched July 2025, Linux Foundation) addresses multi-agent discovery and identity but from a network/interoperability angle, not a per-user consent layer. The Agentic AI Foundation (launched December 2025) is coordinating open standards for agent infrastructure but has not addressed in-conversation feature discovery.

**Key Gap Confirmed:** No existing platform — CMP, feature flag, or agent framework — addresses the specific intersection this spec targets: *an agent's conversational intelligence about its own opt-in feature inventory, governed by user-context-aware state machine logic*. This is a genuine whitespace.

### Market Context

The agentic AI infrastructure market reached ~$101B in 2026 with 14.89% CAGR projected. The "State of AI Agent Security 2026" report notes that nearly all AI agent projects lack per-user consent models and action logging. The EU AI Act's August 2025 requirements for general-purpose AI and August 2026 high-risk provisions are creating compliance pressure that makes structured consent architectures increasingly attractive. Illinois HB 3773 (January 2026) requires notification when AI assists with consequential decisions. The regulatory tail wind is real and accelerating.

---

## Problem-Solution Fit

**Is the problem real?** Yes, unambiguously. Any agent platform with growing feature inventory faces this exact friction: features go undiscovered because the only path is a pull endpoint the user must already know exists. The spec correctly diagnoses the tension between passive (features invisible) and aggressive (agent feels pushy). This is a real UX problem that every agent developer building more than 3-4 opt-in capabilities will eventually confront.

**Would users pay for this?** This is where the framing matters. As an internal component of instar (which is the primary use case as written), the question is whether this increases instar's value enough to justify development cost — the answer is clearly yes. As a standalone product or licensable SDK, the question is harder. The market for "agent feature discovery frameworks" does not yet exist as a purchasing category. The adjacent markets (CMPs, feature flags) are well-served but don't address this problem. A buyer would need to be an agent platform developer, not an end user.

---

## Target Market

**Primary (as-written):** Instar agents and their end users. Justin and other agent operators benefit from higher feature adoption rates; end users benefit from discovering capabilities relevant to their actual problems. Market size here is instar's existing user base — small but growing.

**Secondary (if extracted):** AI agent platform developers who need consent infrastructure. This is a larger opportunity. Platforms like LangChain, CrewAI, or enterprise agentic deployments face the same discovery problem at scale. This is an underserved niche with genuine regulatory tailwinds (EU AI Act, state privacy laws).

**Growth:** The agentic AI market is growing at 46%+ CAGR. Every new agent platform that ships more than a few opt-in capabilities will eventually need this pattern. The market is early but structurally sound.

---

## Competitive Landscape

**Defensible advantage:** The spec's key differentiator is LLM-evaluated contextual triggering — not string matching against capability lists, but genuine semantic understanding of when a feature is relevant. No existing product does this. The `DiscoveryContext` + Haiku-class evaluator design is both technically sound and difficult to replicate without a similar LLM-native architecture.

**Moat analysis:**
- *Shallow moat today:* The concept is not patentable, and a motivated competitor could build similar logic.
- *Deeper moat over time:* The `DiscoveryState` machine accumulates per-user behavioral data (discovery events, engagement patterns). This history becomes increasingly hard to replicate. An agent that knows you declined threadline 3 months ago but have since expanded your multi-device usage is genuinely smarter than one that starts cold.
- *Network effect:* Weak within a single agent. Stronger if discovery state syncs across agents (currently an open question — see Open Questions analysis below).

**Non-competitive zones:** This spec correctly avoids the CMP compliance space (GDPR cookie consent) and the feature flag space (operator-side rollouts). It occupies a distinct layer: agent-side, user-conversational, semantically intelligent. No direct competitors identified.

---

## Revenue & Sustainability

**As an instar internal feature:** No direct revenue, but high value contribution to platform stickiness and feature adoption rates. The success criteria (>30% enable rate for contextually surfaced features) are measurable and commercially meaningful — higher adoption = higher perceived value = lower churn.

**As a potential standalone product:** Several paths exist, none currently specified:
1. Open-source the framework, monetize on instar adoption (current implied path)
2. License as an SDK to other agent platform developers
3. Build a SaaS discovery analytics layer on top (feature funnel metrics sold to enterprises)

The spec is silent on this dimension, which is appropriate for an internal capability spec but worth noting for future positioning.

**Sustainability risk:** Low. The feature requires ongoing LLM evaluation calls (Haiku-class, low cost per call) and state storage (JSONL, negligible). The operational cost profile is favorable.

---

## Network Effects

**Direct network effects:** None at current scope. Each agent-user pair has independent discovery state.

**Potential indirect effects:**
- If discovery state syncs across a user's multiple agents (Open Question #3), collective awareness of what features a user has tried across their agent fleet could improve surfacing quality.
- If anonymous aggregate feature adoption data is used to improve trigger conditions (which features actually get enabled when surfaced in which contexts), this creates a data flywheel — more agents using the framework → better trigger tuning → higher enable rates → more agents adopting the framework.

The spec does not currently design for this flywheel, which is a missed opportunity if the framework is ever extracted for broader use.

---

## Go-to-Market

**For the internal instar use case (immediate):** The go-to-market is the implementation itself. Justin is the first customer. Success is measured by the spec's own success criteria. No external launch needed.

**For a broader audience (hypothetical):** The strongest launch vector would be open-sourcing the `FeatureRegistry` + `DiscoveryState` machine as a reference implementation, writing a post about the "feature discovery problem" in agent platforms, and letting the pattern spread organically through the growing agent developer community. The 2025-2026 agent platform ecosystem is actively seeking infrastructure patterns — the timing is favorable.

**Viral loop potential:** Moderate. Agents built with this framework would, by design, surface the framework's capabilities naturally to users. Meta-virality: the framework is itself an example of good feature discovery. Somewhat elegant.

---

## Risk Assessment

**Biggest unvalidated assumption:** That users *want* contextual feature suggestions from an AI agent. The spec assumes users will respond positively to natural-language feature mentions. But some users experience any unsolicited agent commentary as friction, regardless of how well-timed. The 30% enable rate target for contextually surfaced features is ambitious — there's no comparable benchmark in the literature for this specific pattern.

**What kills this:**

1. *The annoyance failure mode:* If the LLM evaluator surfaces features too aggressively or misjudges context, users will feel pestered. The spec has good guardrails (maxSurfacesBeforeQuiet, one-shot per context, silence during crises) but these require careful calibration. A single bad surfacing experience in a tense debugging session could poison the pattern for that user permanently.

2. *The "declined → forgotten" failure mode:* The spec correctly handles `disabled` state (never re-surface) but the transition from `declined` back to `aware` when "context changes materially" is evaluated by LLM. This is the fuzziest state transition and most likely source of user frustration if the re-surface is misjudged.

3. *Multi-user state fragmentation:* Open Question #2 (per-user vs per-agent discovery state) is identified but not resolved. In multi-user deployments, shared discovery state would create serious problems (User A's declined status silences features for User B). This is not a hypothetical edge case — it's a structural requirement for any commercial deployment. The spec should resolve this before Phase 2.

4. *Evaluator cost creep:* "Runs on every session start" plus "when a problem is detected" could accumulate to more LLM calls than the spec's "negligible cost" framing suggests, especially for power users with frequent sessions. The Haiku-class cost is low but not zero, and should be measured empirically in Phase 3.

---

## Critical Issues

1. **Multi-user discovery state is unresolved and is not optional.** Open Question #2 cannot remain open into implementation. The correct answer is almost certainly per-user state keyed by user identity, not per-agent state. This affects the persistence design in Phase 2 and should be specified before any state machine code is written.

2. **No definition of "context changes materially."** The `declined → aware` transition is the most consequential and most under-specified transition in the state machine. The spec says LLM evaluates this, but gives no criteria. Without concrete examples of what constitutes a material context change, the evaluator has no ground truth to align to, and this transition will be inconsistent across sessions.

3. **The 30% enable rate success criterion needs a baseline.** Is 30% for contextually-surfaced features high or low? Without a comparison (current enable rate via pull-only `/capabilities`, or industry analogues for feature adoption in comparable contexts), this target is unanchored. Recommend measuring current enable rates before shipping Phase 1 to establish baseline.

---

## Recommendations

1. **Resolve multi-user state design before Phase 2.** Define the user identity key and storage path explicitly. `.instar/state/discovery/{userId}/` rather than `.instar/state/discovery/` flat.

2. **Specify "material context change" with 3-5 concrete examples.** Give the evaluator real criteria: "user is now managing multiple machines" (relevant for threadline), "user has set up a new job" (relevant for evolution), etc. This also doubles as documentation for the feature trigger definitions.

3. **Add a "negative discovery" path to scope.** Open Question #4 (unused features, disable suggestions) is the most commercially interesting question the spec raises. Feature bloat is a real problem in any platform. An agent that proactively suggests turning off unused features builds significantly more trust than one that only promotes enabling new ones. Recommend including this in Phase 5 scope rather than deferring indefinitely.

4. **Instrument baseline metrics before Phase 1 ships.** Before the discovery framework changes anything, measure: how often users query `/capabilities`, what fraction of capabilities get enabled by users who do query it, and what the distribution of enabled vs disabled features looks like. This gives Phase 5 analytics something meaningful to compare against.

5. **Consider the "feature itself changed" re-surface case explicitly.** Open Question #1 (declined features that have materially improved) is commercially important. A user who declined threadline when it was experimental but never knew it became stable is missing value. Recommend a versioned feature maturity signal in `FeatureRegistration` that can trigger a re-surface from `declined` when a major version milestone is reached, independent of conversation context.

---

## Observations

**What the spec does exceptionally well:**

- The `ConsentTier` taxonomy (informational / local / network / autonomous) is the best-designed element of the entire spec. It maps cleanly onto real user concerns (privacy, data leaving the machine, agent autonomy) and provides a principled ladder for graduated trust. This alone is worth extracting as a pattern.

- The behavioral contract (DO / DON'T list + surfacing templates) is practical and immediately actionable. Most infrastructure specs stop at the data model; this one tells the agent exactly how to behave, which is the harder problem.

- The principle "context over calendar" (trigger on situation, not on schedule) is correct and important. Time-based feature nudges (the dark pattern used by consumer apps) would be completely wrong for an agent infrastructure platform. The spec correctly rejects this.

- The integration with autonomy profile creates a coherent system: a user in `cautious` mode should never feel like the agent is pitching them. The table mapping profile to discovery behavior is well-reasoned.

**Structural elegance:** The framework separates awareness from activation cleanly. This is non-obvious and important. Many feature discovery systems conflate "you know this exists" with "you're being asked to enable it," creating pressure even for benign features. The three-tier surfacing model (awareness / suggestion / prompt) is the right abstraction.

---

## Scalability Assessment

**Technical scalability:** High. JSONL event log with 90-day retention is lightweight. Haiku-class LLM calls are cheap and can be batched. The state machine is per-user-per-feature, which scales linearly with (users × features) — manageable at any realistic instar scale.

**Organizational scalability:** Medium. The framework requires every new feature to register itself correctly in the `FeatureRegistry` with well-crafted triggers and consent metadata. This is a new discipline for feature authors. If trigger quality is poor (too generic, wrong surfaceAs level), the whole system degrades. Governance of feature registration quality is not addressed in the spec and becomes important as the feature catalog grows.

**Cross-agent scalability:** Currently low (by design — each agent is independent). If instar grows to support agent fleets where users interact with multiple agents across machines, the lack of cross-agent discovery state sync (Open Question #3) becomes a scalability constraint on user experience, not just a technical gap.

---

*Review by Echo (business strategy perspective) — 2026-03-21*

