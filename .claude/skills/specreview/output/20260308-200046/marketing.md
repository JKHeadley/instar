# Marketing & Positioning Review: Discovery Protocol

**Review ID:** 20260308-200046
**Reviewer:** Marketing Strategy & Brand Positioning Specialist
**Spec:** Discovery Protocol — Sub-Agent Opportunity Capture
**Round:** 1
**Date:** 2026-03-08

---

## Approval Status

**CONDITIONAL APPROVAL** — The concept is strong and the internal naming is adequate for a technical protocol, but the name "Discovery Protocol" has significant collision risks in the current AI landscape. Recommended for implementation with naming awareness (see below).

**Score: 7/10**

---

## Research Findings

### Competitive Landscape — Agent Communication Protocols (2026)

The agent protocol space has exploded with named standards, making naming collisions a real brand risk:

- **A2A (Agent-to-Agent Protocol)** — Google's protocol for inter-agent communication. Critically, A2A already uses the concept of "discovery" as a core primitive: agents discover each other's capabilities through an AgentCard at `/.well-known/agent-card.json`. This is the dominant framing of "discovery" in the multi-agent space right now.
- **ANP (Agent Network Protocol)** — Explicitly positioned as the "discovery layer" for agents across networks and organizations. Discovery is in its tagline.
- **MCP (Model Context Protocol)** — Anthropic's protocol for tool/data integration, now under the Linux Foundation. Standard abbreviation pattern: three-letter acronym.
- **ACP (Agent Communication Protocol)** — IBM's protocol, merged into A2A in early 2026.
- **AG-UI** — Agent-User Interaction Protocol for frontend communication.

### Naming Conventions in Agent Tooling

The market has converged on a few patterns:
1. **Descriptive compound words**: LangGraph, CrewAI, AutoGen, AgentFlow
2. **Three-letter protocol acronyms**: MCP, A2A, ACP, ANP
3. **Verb/action names**: Flowise, Zapier Agents
4. **Salesforce guideline**: "Name + Agent" format, first part under 10 characters

### Key Insight: "Discovery" Is Already Claimed

The word "discovery" in the agent protocol space is strongly associated with **how agents find and identify each other's capabilities** (A2A AgentCards, ANP network discovery). This spec uses "discovery" to mean something different — **capturing serendipitous insights during task execution**. This semantic collision will cause confusion when communicating with anyone familiar with the broader agent ecosystem.

---

## Name Analysis

### Current Name: "Discovery Protocol"

| Dimension | Assessment |
|-----------|------------|
| **Memorability** | Medium. Generic but clear. |
| **Searchability** | Poor. "Discovery protocol" returns results about network discovery, service discovery, A2A agent discovery, and scientific discovery protocols. Completely buried. |
| **Semantic accuracy** | Partial. The spec describes opportunity *capture* and *triage*, not discovery in the exploration sense. The sub-agent already discovered the opportunity — this protocol is about not losing it. |
| **Collision risk** | High. Direct collision with A2A's discovery mechanism and ANP's discovery layer. Within the Instar ecosystem this is fine; in any external-facing context it will confuse. |
| **Internal clarity** | Good. Within Instar's own documentation, the meaning is clear from context. |

### Alternative Names (with reasoning)

#### 1. **Serendipity Protocol**
- **Rationale:** Captures the essence perfectly — these are *serendipitous* finds, not planned discoveries. The word is distinctive, memorable, and has zero collision with existing agent protocols.
- **Searchability:** Excellent. No competing technical uses.
- **Risk:** Slightly whimsical; may not land well in enterprise contexts. But for Instar's builder-first culture, it fits.
- **Recommendation:** Top pick.

#### 2. **Salvage Protocol**
- **Rationale:** Emphasizes the core problem: valuable work is being *lost* (reverted, forgotten). This protocol salvages it. Strong action verb. Evokes the real-world example in the spec where hooks were reverted.
- **Searchability:** Good. "Salvage protocol" has no technical competitors.
- **Risk:** Slightly negative connotation (salvage implies damage). But that tension is honest — work IS being lost.
- **Recommendation:** Strong contender. Best for emphasizing the problem.

#### 3. **Fieldnotes Protocol**
- **Rationale:** Borrows from ethnography/research. Sub-agents are doing fieldwork; they jot down observations outside their mission scope. "Fieldnotes" signals: informal, observational, valuable-but-secondary.
- **Searchability:** Good. Distinctive compound word.
- **Risk:** May feel too academic. But it beautifully captures the write-it-down-for-later nature of the mechanism.
- **Recommendation:** Best metaphorical fit.

#### 4. **Aside Protocol**
- **Rationale:** Theatrical term — an aside is when an actor speaks to the audience about something outside the main action. Sub-agents are doing exactly this: breaking from their assigned task to note something for the parent.
- **Searchability:** Moderate. "Aside" is common English, but "Aside Protocol" is unique.
- **Risk:** Less immediately intuitive than the others.
- **Recommendation:** Elegant but niche.

#### 5. **Gleanings Protocol**
- **Rationale:** To glean is to collect valuable remnants after the main harvest. Sub-agents complete their primary task (the harvest) and collect adjacent value (the gleanings). Historical resonance, distinctive, accurate.
- **Searchability:** Excellent. No technical competitors.
- **Risk:** Archaic word; not everyone knows it. But those who do will find it precisely right.
- **Recommendation:** Most poetic option. Works well for documentation and storytelling.

---

## Critical Issues

### 1. "Discovery" Semantic Collision (Severity: Medium)

As detailed above, "discovery" in the 2026 agent ecosystem means capability advertisement and agent-finding (A2A, ANP). Using it for opportunity capture creates ambiguity. This matters less internally than externally, but if Instar ever publishes this protocol or discusses it in the broader agent community, the name will mislead.

**Recommendation:** Rename before it calcifies in documentation and code. Names are cheap to change now and expensive to change later.

### 2. No Elevator Pitch (Severity: Low)

The spec explains the problem well but never distills the value proposition into a single sentence. For internal adoption (getting sub-agents and parent agents to actually use it), there needs to be a one-liner.

**Proposed one-liner:** *"When a sub-agent finds gold while digging for copper, this protocol makes sure the gold doesn't get thrown out with the dirt."*

Or more formally: *"A file-based protocol that lets sub-agents capture valuable out-of-scope findings without polluting their primary work, ensuring no insight is silently lost."*

### 3. Missing "Why Should I Care" for Sub-Agent Authors (Severity: Low)

The spec is written for the system architect (excellent). But the sub-agent prompt injection (Phase 5) is where adoption lives or dies. The current prompt text is purely mechanical — write a file in this format. It doesn't motivate. Sub-agents (especially general-purpose ones) need to understand WHY this matters: "Your out-of-scope work won't be reverted. It will be evaluated fairly."

---

## Recommendations

### Positioning Statement

**Current implicit positioning:** "A protocol for capturing sub-agent discoveries."

**Recommended positioning:** "The protocol that ensures no valuable work is silently lost in multi-agent systems."

This reframes from the mechanism (capturing discoveries) to the outcome (nothing valuable is lost). The emotional hook is the real-world example in the spec — code that was written, working, and valuable getting reverted because it was out of scope. That's a story every developer has lived.

### Messaging Hierarchy

1. **Lead with the pain:** "Sub-agents find valuable improvements all the time. Right now, that work gets reverted."
2. **Show the solution:** "A lightweight, file-based protocol that separates capture from evaluation."
3. **Prove the design:** "Zero overhead when unused. No API required. Convention over configuration."
4. **Future vision:** "Every sub-agent session becomes a source of compound improvement."

### Target Audience Calibration

The spec correctly targets two audiences:
- **Instar maintainers** (system architecture level) — well-served by the current document
- **Agent prompt authors** (integration level) — adequately served by Phase 5

Missing audience:
- **Users who wonder why their agent keeps getting better** — This protocol is part of the "self-improving agent" story. When a user notices their agent handles edge cases it didn't used to, this protocol is one reason why. That story should be told somewhere (not in this spec, but in user-facing materials).

### Competitive Differentiation

This protocol is genuinely novel in the agent tooling space. Most multi-agent frameworks (CrewAI, LangGraph, AutoGen) focus on task decomposition and orchestration — breaking work into pieces and coordinating. None of them address the **serendipitous value capture** problem. This is a differentiator worth highlighting:

- **CrewAI/AutoGen:** Agents do their assigned task. Period.
- **A2A/MCP:** Agents communicate about capabilities and tools. Not about incidental findings.
- **Instar's Discovery Protocol:** Agents capture adjacent value organically, feeding a self-improvement loop.

This positions Instar not just as an orchestration tool but as a **compound learning system** — agents that get smarter through their own work.

---

## Observations

1. **The real-world example is the best marketing asset.** The story of the reverted observability hooks is concrete, relatable, and emotionally resonant. Lead with it everywhere this protocol is discussed.

2. **"File-based, not API-based" is a strong design principle and a strong positioning statement.** It signals simplicity, portability, and respect for constrained environments. This is the kind of design decision that earns trust with infrastructure engineers.

3. **The decision tree in Phase 2 is elegant.** Four clear paths, no ambiguity, forced accountability (dismissed-with-reason). This is the kind of design that should be highlighted in messaging — it shows thoughtfulness.

4. **The <100 token budget for sub-agent prompts is a smart constraint.** It shows awareness of real-world tradeoffs (prompt space is expensive). Worth mentioning in positioning as evidence of practical design.

5. **The "selfAssessment" fields are a subtle but powerful feature.** Sub-agents rating their own findings creates a natural prioritization mechanism. This is worth calling out — it's the kind of meta-cognitive capability that differentiates Instar's approach.

---

## Scalability Assessment

### Name Scalability
"Discovery Protocol" is too generic to scale. As Instar adds more protocols (and it will), generic names create confusion. A distinctive name (Serendipity, Salvage, Fieldnotes, Gleanings) scales better because it occupies its own semantic space.

### Concept Scalability
The protocol itself scales well:
- File-based design means no central bottleneck
- Convention-over-configuration means no setup cost for new agents
- Evolution system integration means discoveries compound over time
- The format is extensible (new fields can be added without breaking existing files)

### Narrative Scalability
The "compound learning" narrative this enables is highly scalable. Every new protocol or feature that feeds into "agents that get smarter through their own work" strengthens the overall Instar story. This protocol should be framed as a foundational piece of that narrative, not a standalone feature.

---

## Summary

The Discovery Protocol is a genuinely novel capability with strong technical design. Its marketing weakness is the name — "discovery" collides with dominant usage in the agent protocol ecosystem and undersells the serendipitous, salvage-oriented nature of what this actually does. Rename it, lead with the reverted-hooks story, and position it as evidence that Instar builds compound learning systems, not just orchestration tools.

---

*Review generated by Marketing Strategy & Brand Positioning Specialist*
*Review ID: 20260308-200046 | Round 1*
