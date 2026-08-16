# Business Review: Discovery Protocol — Sub-Agent Opportunity Capture

**Review ID:** 20260308-200046
**Reviewer:** Business Strategy & Product-Market Fit Specialist
**Spec:** `/specs/discovery-protocol.md`
**Date:** 2026-03-08
**Round:** 1

---

## Approval Status

**CONDITIONAL APPROVAL** — The concept addresses a real and growing problem in multi-agent orchestration. However, the spec positions itself as an internal Instar protocol rather than a product. The business case depends on whether this remains an internal capability or becomes a differentiating feature marketed to the broader agent infrastructure ecosystem.

---

## Score: 7/10

Strong problem identification and practical design. Loses points on market positioning, competitive differentiation against the rapidly maturing Agent Teams paradigm, and absence of any monetization or adoption strategy.

---

## Research Findings

### Multi-Agent Coordination Market (2026)

The multi-agent systems market is experiencing explosive growth. Gartner forecasts 40% of enterprise applications will integrate AI agents by end of 2026 (up from <5% in 2025), and expects a third of agentic AI deployments to run multi-agent setups by 2027. However, Gartner also warns that 40%+ of agentic AI projects could be canceled by 2027 due to runaway costs, unclear value, or missing risk controls.

**Key frameworks in market:** LangChain/LangGraph (dominant but facing performance pressure), CrewAI (100K+ certified developers, claiming 5.76x faster than LangGraph), Microsoft Agent Framework (AutoGen + Semantic Kernel merged, 1.0 GA targeting Q1 2026), Google ADK, and OpenAI Agents SDK. The space has 40+ active frameworks with 94K+ GitHub stars across the top entries.

**Standardization wave:** Three major protocols are crystallizing — MCP (agent-to-tool), A2A (agent-to-agent with Agent Cards for capability discovery), and ACP (lightweight messaging). These address inter-agent communication but not the specific problem of intra-task serendipitous discovery.

### Claude Code Agent Teams (Direct Competitive Pressure)

Claude Code shipped "Agent Teams" in February 2026 alongside Opus 4.6. Unlike traditional sub-agents that report back to a single orchestrator, teammates communicate directly with each other, share discoveries mid-task, and coordinate through a shared task list and mailbox system. **This is the most significant competitive development** — Anthropic's own infrastructure is moving toward richer inter-agent communication that could subsume the discovery protocol's value proposition if Agent Teams evolves to handle out-of-scope findings natively.

### Serendipitous Discovery — An Underserved Problem

Research in autonomous AI systems highlights a tension between efficiency optimization and serendipitous breakthroughs. Current multi-agent frameworks focus on task delegation and result aggregation but lack structured mechanisms for capturing valuable side-findings. Most frameworks either discard out-of-scope work or leave it to ad-hoc logging. The discovery protocol addresses a genuine gap that no major framework has formalized.

### Knowledge Persistence Patterns

Knowledge graphs and GraphRAG are emerging as coordination hubs for multi-agent systems. The trend is toward persistent, searchable knowledge stores that survive across sessions. The discovery protocol's file-based approach aligns with this trend at a simpler layer — it's a lightweight capture mechanism rather than a full knowledge graph, which is appropriate for its scope.

---

## Critical Issues

### 1. Agent Teams Overlap Risk (High)

Claude Code's Agent Teams feature (shipped Feb 2026) introduces shared task lists and mailbox systems for inter-agent communication. If Anthropic extends this to handle out-of-scope discoveries — which is a natural evolution — the discovery protocol becomes redundant for Claude Code users. The spec does not acknowledge or address this competitive dynamic.

**Recommendation:** Explicitly position the discovery protocol as complementary to Agent Teams (for hierarchical sub-agent patterns where Teams isn't used) or as a fallback for environments without Agent Teams support. Alternatively, propose this as an upstream contribution to the Agent Teams specification.

### 2. No Adoption Strategy (High)

The spec describes what to build but not how to get sub-agents to actually use it. Adding ~100 tokens to sub-agent prompts is necessary but not sufficient. Sub-agents are stateless by design — they follow instructions in their prompt window. The discovery protocol relies on sub-agents:
- Recognizing what's "out of scope" (requires judgment)
- Choosing to write a file instead of inlining changes (requires discipline)
- Producing well-structured JSON (requires format compliance)

Without empirical evidence that sub-agents will reliably follow the protocol, the design is theoretical. The real-world example in the spec (the `init.ts` case) shows a sub-agent that *did* the work inline — the protocol would need to change that behavior, not just provide an alternative channel.

### 3. No Metrics or Feedback Loop for Protocol Effectiveness (Medium)

The spec mentions "discovery quality scoring" as future work but provides no mechanism to measure whether the protocol is working in Phase 1. Without tracking discovery-to-application rates, false positive rates, or prompt compliance rates, there's no way to iterate on the design.

---

## Recommendations

### R1: Position as Instar Differentiator, Not Just Internal Protocol

The discovery protocol solves a problem no major framework has formalized. This should be explicitly positioned as a selling point for Instar: "Your sub-agents never lose valuable work." Frame it in marketing terms — this is a feature that makes Instar agents measurably more productive than agents on competing platforms.

### R2: Build the Triage UX First, Capture Second

The spec's implementation plan starts with the capture side (directory, schema, sub-agent prompts). This is backward from a business perspective. The *triage* experience is what delivers value — a parent agent that surfaces, evaluates, and routes discoveries efficiently. Build the triage skill (`/triage-discoveries`) first, seed it with manually-created discovery files to validate the UX, then wire up automatic capture. This de-risks the hardest uncertainty (will the triage flow actually be useful?) before investing in the capture infrastructure.

### R3: Add Protocol Compliance Tracking

Include a simple counter in the session-start hook: how many discoveries were created vs. how many sub-agent sessions ran. This gives an immediate signal on adoption rate. If sub-agents aren't creating discoveries, the prompt injection needs iteration — and you want to know that in week 1, not month 3.

### R4: Propose Upstream to Anthropic

The discovery protocol pattern is generalizable beyond Instar. Consider submitting this as a feature request or RFC to Claude Code's Agent Teams / sub-agent system. If Anthropic adopts the pattern natively, Instar benefits from platform-level support. If they don't, Instar has a genuine differentiator. Either outcome is favorable.

### R5: Address the Worktree Isolation Problem Now, Not Later

Open Question 3 (worktree isolation) is not a "future enhancement" — it's a blocking issue for a significant portion of sub-agent usage. Sub-agents running in worktrees can't write to `.instar/state/discoveries/` because it's in the main worktree. The spec should include a concrete solution (e.g., a post-merge hook that copies discoveries from worktree to main state, or a shared directory outside the worktree).

---

## Observations

### What the Spec Gets Right

1. **File-based, not API-based** — This is the correct architectural choice. Sub-agents operate in diverse environments (worktrees, sandboxes, resource-constrained contexts). A filesystem convention has maximum compatibility and zero dependencies. This is a design decision that shows deep understanding of the operational reality.

2. **Separation of capture and evaluation** — Decoupling the sub-agent's responsibility (write a file) from the parent's responsibility (evaluate and route) is clean and follows the single-responsibility principle. This makes each side independently testable and evolvable.

3. **Integration with existing evolution system** — Rather than building a parallel tracking system, discoveries flow into the existing evolution proposal pipeline. This is efficient design that leverages sunk infrastructure cost.

4. **The "dismissed-with-reason" requirement** — Forcing conscious evaluation rather than silent discard is a subtle but important UX decision. It prevents the default behavior (revert and forget) without adding significant overhead.

5. **Realistic time estimate** — 4 hours for the full implementation is credible and appropriately scoped for a protocol that can be iterated.

### Concerns

1. **JSON schema complexity for sub-agents** — The discovery file format has 15+ fields. Sub-agents operating under token pressure may produce malformed JSON or skip optional fields in ways that break parsing. Consider a minimal required schema (5-6 fields) with everything else optional and defaulted.

2. **Discovery spam risk** — Without quality gates, an overzealous sub-agent could produce low-value discoveries on every run, creating triage fatigue. The self-assessment fields help but are self-reported by the entity that has an incentive to overstate value.

3. **30-day TTL auto-proposal** — Auto-filing as evolution proposals after 30 days of neglect just moves the noise to a different queue. Consider auto-dismissal with a summary notification instead.

---

## Scalability Assessment

### Technical Scalability: Good

File-based capture scales linearly with sub-agent count. JSON files in a directory are simple to enumerate, process, and archive. The `processed/` subdirectory pattern prevents unbounded growth. No database, no API dependency, no coordination overhead.

### Organizational Scalability: Moderate

The protocol works well for a single agent with a handful of sub-agents (Instar's current model). For scenarios with dozens of concurrent sub-agents, discovery volume could overwhelm the triage step. The spec acknowledges this implicitly with the "automated triage" future work item, but the initial manual triage design may hit limits faster than expected in production.

### Market Scalability: Needs Work

As an Instar-internal protocol, scalability is bounded by Instar's agent count. As a general-purpose pattern contributed to the broader ecosystem (via Anthropic, open-source, or industry RFC), the ceiling is much higher. The spec should explicitly consider which path it's targeting.

### Cross-Agent Scalability: Not Addressed

The spec notes "cross-agent discovery sharing" as future work. In a world where multiple agents operate on the same codebase or project, discoveries from one agent could be valuable to others. This is where the discovery protocol could become a genuine platform feature rather than a single-agent optimization.

---

## Competitive Landscape Summary

| Solution | Approach to Out-of-Scope Findings | Status |
|----------|----------------------------------|--------|
| **Discovery Protocol (this spec)** | Structured file-based capture with triage pipeline | Draft |
| **Claude Code Agent Teams** | Shared mailbox and task list for inter-agent communication | Shipped (Feb 2026) |
| **A2A Protocol** | Agent Cards for capability discovery; no side-finding capture | Standard |
| **CrewAI** | Task callbacks and crew memory; no structured discovery mechanism | Production |
| **LangGraph** | State graph with checkpoints; side-effects are manual | Production |
| **Microsoft Agent Framework** | Structured conversation logs; no discovery separation | Pre-GA |
| **Google ADK** | AgentTool wrapper forwards state/artifact changes; no discovery protocol | Production |

**Key insight:** No major framework has formalized the concept of "valuable side-findings from focused tasks." They all handle task results and inter-agent communication, but the serendipitous discovery pattern is unaddressed. This is a genuine whitespace opportunity — but it's also small enough that any framework could add it as a minor feature, so the window for differentiation is narrow.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent Teams subsumes discovery protocol | Medium | High | Position as complementary; propose upstream |
| Sub-agents don't reliably follow protocol | Medium | High | Empirical testing with current sub-agents; iterate prompt |
| Discovery spam creates triage fatigue | Medium | Medium | Quality gates, rate limits, auto-dismiss thresholds |
| Worktree isolation blocks core use case | High | Medium | Solve in Phase 1, not future work |
| JSON schema too complex for token-constrained sub-agents | Medium | Medium | Minimal required schema with generous defaults |
| Protocol remains Instar-internal, limiting impact | Medium | Low | Explicit decision on upstream contribution strategy |

---

## Bottom Line

The Discovery Protocol addresses a real, unserved need in multi-agent systems: structured capture of valuable side-findings that would otherwise be lost. The design is pragmatic, file-based, and well-integrated with existing Instar infrastructure. The ~4-hour implementation cost is low relative to the potential value.

The primary business risks are (1) competitive overlap with Claude Code's Agent Teams, which could naturally evolve to cover this use case, and (2) the assumption that sub-agents will reliably follow the protocol without empirical validation. Both are addressable.

**Strategic recommendation:** Build it, validate it with real sub-agent sessions, measure compliance and discovery quality, then decide whether to upstream it as an Anthropic RFC or keep it as an Instar differentiator. The low implementation cost makes this a worthwhile bet regardless of which path wins.
