# Business Model Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: Business Model
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: APPROVE

---

## Improvements Since Round 1

1. **Rename to "Coherence Gate"** (was P0) — NOW ADDRESSED. The spec title, config keys, and API endpoints all use "Coherence Gate." The tagline is right at the top: "Guardrails stop your agent from saying dangerous things. The Coherence Gate stops it from saying things that don't sound like it."

2. **Custom reviewer interface** (was P0 from DX) — NOW ADDRESSED. `ReviewerSpec` contract, `.instar/reviewers/` auto-discovery, LLM-powered and programmatic options. This is the extensibility foundation that enables a marketplace later.

3. **Shadow mode / observe-only** (was P0 from DX) — NOW ADDRESSED. `observeOnly: true` config option. Essential for adoption — operators can try before they commit.

4. **Migration plan** (was P1) — NOW ADDRESSED. 5-week phased rollout: shadow → parallel → full → cleanup. Rollback triggers defined. This is exactly what was needed.

5. **Cost model corrected** (was conflict) — NOW ADDRESSED. ~$3-6/month per agent is a non-issue for adoption.

---

## Research Findings

- **Guardrails AI**: Focuses on output structure validation (RAIL spec). Open-source with cloud offering. Does not do identity-grounded review — purely structural validation. Pricing: usage-based, starts free.
- **NeMo Guardrails (NVIDIA)**: Open-source. Uses Colang for flow control. Five rail types. ~0.5s latency for 5 parallel guardrails. No identity/value grounding. Strongest on dialog flow control.
- **Lakera Guard**: Plug-and-play prompt injection detection. Fastest to deploy. No agent identity awareness. Purely security-focused.
- **Market gap confirmed**: No competitor offers identity-grounded response review. The market has: safety guardrails (Guardrails AI, Lakera), flow control (NeMo), and eval tools (Promptfoo, Braintrust). Nobody occupies the "coherence" / "does this sound like the agent?" niche.
- **AI agent market**: Growing rapidly. Agent frameworks (LangChain, CrewAI, AutoGen) proliferating. Quality assurance for agent output is an emerging need with no clear winner.

---

## Critical Issues (must fix before building)

None. All Round 1 business-critical issues have been addressed.

---

## Recommendations (should fix, not blocking)

### 1. The Organic Evolution System Is a Competitive Moat — Invest Here (HIGH STRATEGIC VALUE)
**Section**: Organic Evolution — Self-Healing Coherence

This is the most strategically important addition since Round 1. The local self-patching + upstream signal + global aggregation cycle is something no competitor has or is building toward. It creates a data flywheel:
- More agents → more coherence signals → better global prompts → better agents → more adoption
- Each agent's local patches make it more valuable over time (switching cost)
- The global pattern detection creates a network effect — every agent benefits from every other agent's failures

**Suggestion**: This should be the leading narrative for technical audiences. "A coherence gate that learns from every agent's mistakes and gets better over time" is the pitch. The incident appendix supports it — every reviewer traces to a real failure, and the learning loop ensures new failures get caught.

### 2. Publish the Dawn Incident Appendix (HIGH MARKETING VALUE)
**Section**: Appendix A

Round 1 recommended this. Round 2 expands the appendix with even richer content. "9 Real Ways AI Agents Fail Their Users" or "What Goes Wrong When AI Agents Talk to People" is genuinely publishable content that:
- Validates the problem (these are real incidents, not hypotheticals)
- Demonstrates expertise (deep operational knowledge of agent systems)
- Creates demand for the solution (readers recognize these patterns in their own agents)
- Generates backlinks and SEO for "agent coherence"

### 3. Custom Reviewer Marketplace Potential (MEDIUM, FUTURE)
**Section**: Custom Reviewer Interface

The `ReviewerSpec` contract + `.instar/reviewers/` auto-discovery is the foundation for a reviewer marketplace. Operators building domain-specific reviewers (healthcare compliance, financial regulation, brand voice) could share them. This is the extension point where platform value exceeds individual feature value.

**Suggestion**: Design the `ReviewerSpec` with sharing in mind. Consider a `visibility: "local" | "shared"` field. When shared reviewers ship via dispatch, the flywheel accelerates.

### 4. Recipient-Aware Grounding as a Selling Point (MEDIUM)
**Section**: Recipient-Aware Grounding

Four recipient types with different review strictness is genuinely novel. No guardrails system adapts review based on who the message is going to. This is especially relevant for enterprise use cases where agents communicate with external contacts (customers, partners) on behalf of users.

**Suggestion**: Position this in marketing as "context-aware quality" — the system knows that an internal Slack message and a customer email need different standards.

---

## Observations

1. **First-mover window holding**: Round 1 estimated 6-12 months. The market has not changed materially. Guardrails AI and NeMo remain focused on safety/structure. Nobody has entered the coherence/identity space.

2. **The "Coherence Gate" name works**: It's not claimed by competitors, it captures the differentiator, and it implies enforcement. Round 1 was right to push for the rename.

3. **The information boundary rule** (Section: Recipient-Aware Grounding) is a feature with regulatory value. GDPR data minimization and purpose limitation directly align with "don't leak User A's context to User B."

4. **The learning loop cost is near-zero**: Complaint classification is one Haiku call per incoming message. Local patching is file writes. Upstream signaling is one HTTP POST. The ROI is asymmetric — trivial cost for compounding quality improvement.

---

## Scalability Assessment (Business Model)

| Phase | Assessment | Key Dynamics |
|-------|-----------|-------------|
| MVP (1-10 agents) | Strong | Instar's existing user base. $3-6/month/agent is invisible. Dogfooding validates the product. |
| Growth (10-100) | Strong | Word-of-mouth from incident appendix publication. Custom reviewers attract power users. |
| Scale (100-1K) | Strong | Organic evolution creates network effects. Global pattern detection makes every agent better. Marketplace potential for custom reviewers. |
| Enterprise (1K+) | Needs work | Enterprise needs: SOC2 compliance, dedicated infrastructure, SLA guarantees, audit export. Not blocked but not addressed. |

---

## Score: 8.5/10

**Justification**: Major improvement from Round 1 (was 7/10). Every business-critical Round 1 issue is resolved. The name is right, the cost is right, the extensibility is right, and the migration plan removes adoption risk. The organic evolution system is a strategic asset that creates compounding value and switching costs. The remaining gap is enterprise readiness (SOC2, SLA), which is appropriate to defer. This is a well-designed product with a clear market position and no direct competitors in its niche.
