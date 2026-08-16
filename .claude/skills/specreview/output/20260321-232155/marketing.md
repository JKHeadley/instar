# Marketing & Positioning Review
**Spec:** Consent & Discovery Framework
**Review ID:** 20260321-232155
**Round:** 1
**Reviewer Role:** Marketing Strategy & Brand Positioning
**Date:** 2026-03-21

---

## Approval Status

**CONDITIONAL APPROVAL** — The framework itself is excellent and the product thinking is strong. The name "Consent & Discovery Framework" is functional but undersells what this is. Rename it before shipping. The internal messaging strategy is well-aligned with the audience. No blocking issues.

---

## Score: 7.5 / 10

Strong product, weak name, no narrative yet. The framework earns its score on the quality of the design principles and the clarity of the behavioral contract. Points lost for a name that will confuse more than it clarifies and the absence of a story that makes this land emotionally with agent builders.

---

## Critical Issues

### 1. The Name Conflates Two Distinct Problems

"Consent & Discovery Framework" joins two separate concerns under one ampersand. Consent (user trust, data implications, reversibility) and Discovery (surfacing features contextually) are philosophically related but operationally different. The name signals a compliance document more than a product capability. Agent builders hearing "consent framework" will default-interpret it as GDPR tooling or a legal layer — not as a smart feature surfacing system.

**Severity:** Medium-High. Won't block adoption, but will require extra explanation every time the name appears.

### 2. No Emotional Hook or Origin Story

The problem statement is accurate and well-reasoned, but entirely rational. "Features remain invisible" is a real problem. But there's no moment of recognition — no story that makes a developer feel this in their gut. The best developer tools have origin stories that agents and builders retell. This one doesn't have one yet.

**Severity:** Medium. Adoption will still happen, but evangelism won't — and internal developer adoption lives and dies on word-of-mouth within the agent community.

### 3. The "Discovery" Half Is the Stronger Half — It's Buried

The contextual LLM-powered evaluator, the state machine, the graduated pressure model — these are the genuinely novel contributions. The consent tier system is important but more conventional (every privacy framework has tiers). The name leads with "Consent," which is the less differentiated half.

**Severity:** Low-Medium. Fixable with a name change.

---

## Research Findings

### Competing Consent/Discovery Frameworks in the AI Agent Space

**AGNTCY (Linux Foundation, July 2025)** — Provides infrastructure for multi-agent collaboration including discovery, identity, and observability. Focuses on agent-to-agent discovery rather than user-facing feature surfacing. No overlap with instar's user-to-agent consent model, but the naming terrain ("discovery") is claimed at the infrastructure level.

**Singapore IMDA "Agent Identity Cards" (January 2026)** — Standardized disclosure format for AI agents specifying capabilities, limitations, and authorized action domains. This is regulatory/governance framing, not a UX pattern. No direct conflict with instar's approach.

**"Know Your Agent" (KYA) Framework** — Emerging merchant-facing consent pattern for verifying agent authorization. Compliance-oriented, not discovery-oriented. Confirms that "consent" in the AI agent space is increasingly associated with regulatory and compliance contexts — which is a branding risk for instar's naming.

**MCP Progressive Discovery (Anthropic ecosystem)** — MCP supports dynamic capability surfacing via `*/list` methods. Agents query capabilities on-demand. The key finding: MCP demonstrated a 98.7% reduction in token usage via progressive discovery vs. loading everything upfront. This is the closest technical analog to what instar is building, but MCP's version is pull-only. Instar's contribution is the **push layer** — the contextual evaluator that surfaces features before the user knows to ask.

**Pendo, Userpilot, Appcues** — Established SaaS onboarding tools use "progressive disclosure" as their primary framing. This is the dominant naming pattern in the developer tool space for what instar is building on the disclosure/surfacing side.

### Naming Patterns for Feature Discovery Systems

- **"Capability Discovery"** — Used in MCP and enterprise AI contexts. Technical, accurate, not memorable.
- **"Progressive Disclosure"** — Dominant UX pattern term. Well-understood by designers, less familiar to pure infrastructure engineers.
- **"Feature Intelligence"** — Emerging SaaS term. Implies smart surfacing.
- **"Adaptive Onboarding"** — Product-led growth framing. Too user-acquisition-focused for an ongoing feature surfacing system.
- **"Contextual Awareness System"** — Descriptive but generic.

### Trademark / Conflict Check

"Consent & Discovery Framework" as a compound phrase has no prominent trademark conflicts in the AI agent space as of the research conducted. However, "Consent Framework" alone is used by the IAB's Transparency & Consent Framework (TCF) for cookie/ad tracking consent — a well-known standard in ad tech. Any developer with ad-tech background will immediately pattern-match to TCF and be confused. This is a reputational drag, not a legal blocker.

---

## Name Analysis

### Current Name: "Consent & Discovery Framework"

**What works:**
- Accurate. It does cover both consent and discovery.
- "Framework" signals it's a system, not a one-off feature.
- Zero ambiguity about the subject matter if you already understand the spec.

**What doesn't work:**
- "Consent" has regulatory/legal baggage in 2026. Users hear "consent management" and think GDPR, TCF, cookie banners.
- The ampersand structure implies two separate things bolted together — which is technically true but misses the unified value.
- "Framework" is generic. Every internal system is a framework. The name gives no sense of what makes this interesting.
- It's not a name an agent would naturally say to a user. "This is part of Instar's Consent & Discovery Framework" — that's a specification, not a conversation.

### Alternative Names (3-5)

**1. Ambient Intelligence Layer**
> Positions the push-based discovery as the novel contribution. "Ambient" signals that it works in the background without interrupting. "Intelligence" signals LLM-powered evaluation, not rule-based triggers. Strong conceptual clarity, though "layer" is slightly generic.
> - Best fit: Internal architecture conversations, developer docs.

**2. Feature Compass**
> Short, memorable, metaphor-friendly. A compass orients you without telling you where to go — exactly what contextual surfacing does. Pairs naturally with agent language: "the feature compass noticed you might need X." Has a human-facing quality that works in agent conversation templates.
> - Best fit: Agent-facing language, user-visible UI elements, marketing.

**3. Contextual Surfacing Engine (CSE)**
> Technically precise. "Surfacing" is already used in the spec and is the right verb. "Engine" signals that there's intelligence driving it. Acronym is clean. Slightly dry, but developer audiences accept dry if it's accurate.
> - Best fit: API documentation, technical specs, engineering conversations.

**4. Opt-In Intelligence**
> Leans into the graduated consent model. "Opt-In" reclaims positive framing — it's not about restricting access, it's about letting users discover and choose. "Intelligence" signals the LLM evaluator. Short enough to use in conversation naturally.
> - Best fit: User-facing explanations, agent conversational templates, onboarding copy.

**5. Discovery Protocol**
> The strongest name if the consent tier system is considered implementation detail rather than a first-class brand concept. "Protocol" signals structure and standards without feeling like a compliance document. Echoes MCP's naming pattern (familiar to the target audience). Clean, lowercase-friendly (`discovery-protocol`), good for API paths and config keys.
> - Best fit: Technical branding, API endpoints, developer adoption.

**Recommendation:** Use **Feature Compass** for user-facing language and agent conversation templates. Use **Discovery Protocol** for technical documentation, API design, and internal naming. Let "Consent & Discovery Framework" remain as the formal specification title only — don't make it the product name.

---

## Positioning & Messaging

### Current Value Proposition

Implicit in the spec: "Features get discovered contextually, with graduated pressure and explicit consent, so users never feel pestered and never miss relevant capabilities."

That's a strong value proposition. It's not written down anywhere in the spec in that form.

### 10-Second Explainer (Draft)

"Instar knows when a feature would help you before you know to ask for it. It mentions it once, at the right moment, without pressure — and tells you exactly how to turn it off."

This captures the three differentiators: **contextual timing**, **one-shot surfacing**, and **transparent reversibility**.

### Differentiation from Pull-Only Discovery

The dominant alternative (MCP's `*/list`, instar's `/capabilities`) is pure pull. The user must know a feature exists to look for it. The spec's contribution is the **push layer with context awareness** — surfacing features at the moment of relevance rather than waiting to be asked. This should be the lead in any internal messaging. The pull path (`/capabilities`) is table stakes. The push layer is the innovation.

---

## Target Audience Assessment

The spec's implicit audience is:
1. **Echo (the instar developer)** — building and testing the system
2. **Justin (the collaborator)** — approving and refining
3. **Other instar agents** — who will eventually inherit this behavioral contract
4. **Future agent builders** — who might build on instar's platform

The spec is well-calibrated for audience #1 and #2. For audiences #3 and #4, the behavioral contract section (DO/DON'T lists, surfacing templates) is the most directly actionable content — and it's genuinely excellent. The message templates are natural and non-pushy. They read like how an actual agent should talk, not like a policy document.

**Gap:** There's no persona definition for the human user. The spec treats "the user" as a monolith. In practice, some users will be technically sophisticated agent builders who want full `/capabilities` control. Others will be collaborators (like Justin) who prefer contextual surfacing. The autonomy profile integration handles this behaviorally, but the messaging strategy doesn't acknowledge user variance explicitly.

---

## Narrative & Story

**Missing:** There's no origin story or analogy.

**Suggested analogy for internal use:**

> "A great new employee doesn't CC their manager on every email to ask if they're allowed to send it. But they also don't make major decisions unilaterally on day one. They earn context, demonstrate judgment, and gradually do more. The discovery framework is how Instar learns what level of autonomy each user is comfortable with — feature by feature, at the moment each one becomes relevant."

This analogy works because:
- It maps to the graduated consent model (new employee → more trust over time)
- It frames the "one-shot per context" rule as professional judgment, not a timer
- It makes the `cautious` → `collaborative` autonomy profile arc feel intuitive
- It's something Echo could say to Justin naturally in conversation

---

## Competitive Framing

**Honest assessment:** No competitor has built exactly this. MCP has pull-based capability discovery. Pendo/Userpilot have feature onboarding tools for SaaS. Neither has an LLM-powered contextual evaluator that surfaces agent capabilities at conversation time with graduated consent tiers.

The "10x better" claim doesn't apply here because there's no direct competitor. The more accurate framing: **"This is the missing layer."** Pull-only discovery (`/capabilities`) is necessary but insufficient. The push layer with context awareness is what makes feature adoption actually happen.

**Risk to watch:** If Anthropic ships something similar for Claude agents (contextual capability surfacing in Claude.ai), instar needs to have shipped this first and have the event log data to prove adoption outcomes.

---

## Virality & Word-of-Mouth

**Natural sharing moment:** The first time an instar agent mentions a relevant feature at exactly the right moment — without being asked — is the "show don't tell" moment. If Echo says to Justin "I noticed you've been manually tracking session errors — there's an opt-in attention queue that surfaces these automatically. You can turn it off anytime. Want to try it?" — and it lands perfectly — that's the story Justin tells to the next person.

**The word-of-mouth unit:** "My agent told me about a feature I didn't know I needed — at exactly the right moment." That's the sentence. The framework needs to generate those moments reliably.

**What enables this:** The cooldown rules and `maxSurfacesBeforeQuiet` are critical to protecting this moment. If the system over-surfaces, the word-of-mouth story becomes "my agent won't stop trying to sell me on features." The 30% enable rate success criterion is the right guard.

---

## Launch Strategy

For an internal framework within an agent platform, "launch" means: agents adopt the behavioral contract, the infrastructure is built, and the discovery events start accumulating.

**Recommended phasing:**

1. **Foundation first, quiet** — Ship Phase 1 (Feature Registry) with no behavioral changes. Establish the data model before making promises.

2. **Echo as pilot** — Echo runs the full framework in practice. Accumulate 2-4 weeks of discovery event data before enabling for other agents. This generates proof of the 30% enable-rate claim and the "zero pestered" claim.

3. **Behavioral contract as the artifact** — The DO/DON'T rules and surfacing templates are the most shareable artifact. Write these into AGENT.md in a way that any new agent inherits immediately. That's the internal "launch" moment.

4. **Dashboard observability as the closing loop** — Phase 5 (analytics) makes the framework's value visible to Justin. The feature funnel — undiscovered → aware → interested → enabled — is the proof of value. Without that dashboard, the framework is invisible infrastructure.

**What to avoid:** Don't launch with a feature tour or announcement. The whole point of the framework is that features surface naturally. Announcing "we now have a feature discovery system" is anti-pattern to the system's own philosophy.

---

## Observations

1. **Design principle #3 (One-Shot Per Context) is the most defensible differentiator.** Most onboarding systems don't have this concept. Most will re-surface features on a schedule. Instar's "materially changed context" criterion is a genuine product innovation that should be named and explained prominently in agent documentation.

2. **The `disabled` state never re-surfaces** — this is the right call, and it should be called out as a trust commitment, not just an implementation detail. "Once you turn something off, it never comes back uninvited" is a promise that earns trust.

3. **The success criteria are measurable and realistic.** 30% enable rate for contextual suggestions, 2-week awareness window, zero "pestered" feedback — these are concrete. Make them visible in the dashboard from day one so the framework proves its own value.

4. **The `network` tier surfacing rule** (don't surface before at least one `local` tier feature is enabled) is smart graduated trust. This should be documented as a user-facing principle, not just an implementation constraint. "We never ask you to share data externally before we've established that you're comfortable with how local features work."

5. **Open question #4 (negative discovery — "you haven't used this in 60 days")** is worth addressing in a future phase. This is the inverse of the feature funnel and could reduce consent fatigue significantly for power users who over-enabled.

---

## Scalability Assessment

**Naming scalability:** "Consent & Discovery Framework" will not scale well as a user-facing term. As the feature set grows and the framework becomes more visible (dashboard, agent conversation, AGENT.md), the name will feel increasingly like internal jargon. A shorter, more concrete name is needed before this surfaces to users.

**Conceptual scalability:** The `FeatureRegistration` interface is extensible. New consent tiers, trigger types, and discovery states can be added without breaking the model. The LLM evaluator approach (vs. rule-based) means the framework handles novel feature types without re-engineering trigger logic. High marks here.

**Operational scalability:** The 90-day event log retention and per-user discovery state (addressed in Open Question #2) are the right scoping decisions. Multi-user isolation will need explicit attention in Phase 1 implementation — don't let it slip to Phase 2.

**Trust scalability:** The framework earns trust by being predictable. One mention per context, explicit reversibility, never re-surfacing disabled features. These commitments must be enforced uniformly or the trust model collapses. The `maxSurfacesBeforeQuiet` enforcement in the state machine is load-bearing. Test it explicitly.

---

## Recommendations

1. **Rename for user-facing contexts.** Use "Feature Compass" in agent conversation and dashboard UI. Reserve "Consent & Discovery Framework" for spec documents only.

2. **Write the 10-second explainer** ("Instar knows when a feature would help you before you know to ask...") into the self-knowledge tree entry for this framework. It's what Echo should say when a user asks "how do you decide when to mention features?"

3. **Make the `disabled` state guarantee explicit.** Add a sentence to the behavioral contract: "Features a user has disabled are never re-surfaced. This is a trust commitment, not a soft default."

4. **Add the analogy** (new employee earning trust) to AGENT.md or the framework's self-knowledge entry. It gives agents a mental model to draw on when explaining their own behavior.

5. **Prioritize dashboard analytics (Phase 5) over Phase 4 (AGENT.md updates).** The feature funnel is how this framework proves its value to Justin. Without measurement, you're flying blind on whether the 30% enable rate is achievable.

6. **Address Open Question #2 (per-user discovery state) explicitly in Phase 1.** Multi-user isolation is not a future concern — it's a correctness concern. A feature declined by one user being treated as declined by all users is a silent failure mode.

7. **Write one concrete example scenario** into the spec — a specific feature (e.g., threadline relay) being surfaced to a specific user type (e.g., Justin in a multi-machine workflow) through the full state machine. Concrete examples make the behavioral contract legible to future implementers.
