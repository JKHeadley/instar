# Business Model Review: Coherence Gate — Round 3

**Reviewer**: Business Strategy & Product-Market Fit Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 8.5/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 9.0/10 (+0.5 from Round 2)

---

## Round 2 P1 Resolution

### P1: Patch Poisoning Governance — RESOLVED
The operator-approval queue for patches (lines 1097-1167) directly addresses the Round 2 concern about automatic self-patching as a prompt injection vector. Patches enter a proposal queue. Operators review via `GET /coherence/proposals` or attention queue items. API for approve/reject. Optional `autoApproveRisk: "low"` for operators who want reduced friction on low-risk patches.

This is the right balance: security by default (no auto-approve), convenience when explicitly opted in. It also creates a data point for product analytics — how often do operators approve vs reject? What's the ratio of low vs high-risk proposals? This feeds product decisions about default behaviors.

---

## Assessment of New Additions

### PEL as a Business Feature — Underappreciated
The Policy Enforcement Layer is positioned as a security feature, but it's equally a business differentiator. Enterprise buyers want deterministic guarantees, not probabilistic ones. "Your agent will NEVER expose credentials in outgoing messages — guaranteed, not probabilistically" is a stronger sales pitch than "our LLM reviewers catch credential exposure most of the time."

PEL + LLM reviewers is the correct two-tier story: deterministic guarantees for hard policies, intelligent judgment for soft qualities.

### Recipient-Aware Review — Enterprise Selling Point
The 4-recipient-type system (primary-user, secondary-user, agent, external-contact) with per-type review strictness is something no competitor offers. For enterprises where agents communicate with customers, partners, and other systems, this is table stakes. The spec delivers it from day one.

The AgentTrustManager integration for agent-to-agent communication (lines 1699-1710) positions the Coherence Gate for multi-agent environments — which is where the enterprise market is heading.

### Information Leakage Reviewer — Enterprise-Critical
A dedicated reviewer preventing agents from leaking primary user context to other recipients (line 1723) addresses a real enterprise concern: data boundary enforcement. When an agent emails a customer, it must not reference internal project details. This reviewer enforces that boundary.

### Organic Evolution with Governance — The Moat Deepens
Round 2 identified organic evolution as the strategic moat. Round 3 strengthens it with governance:
- Complaint detection is async (no latency impact on the input path)
- Triage gate eliminates 70-80% of messages from classifier cost
- Patches require operator approval (security) but the workflow is lightweight (product usability)
- The feedback loop to instar's platform means every agent's learnings benefit all agents

The full cycle: user complaint → local proposal → operator approval → upstream signal → global aggregation → dispatch to all agents. This is a genuine data flywheel that compounds over time.

### Failure Mode Differentiation — Correct for Business
The distinction between retry exhaustion on tone issues (auto-deliver) vs accuracy/alignment issues (hold for operator review) is business-critical. A slightly informal message is acceptable. A fabricated claim sent to a customer is a reputational risk. The spec makes the right call.

---

## Competitive Position — Strengthened

The additions since Round 2 widen the gap:

| Dimension | Coherence Gate | Guardrails (Safety) | Eval Platforms (Accuracy) |
|-----------|---------------|--------------------|--------------------------|
| Hard policy enforcement | PEL (deterministic) | Yes (their core) | No |
| Semantic quality | 7+ LLM reviewers | No | Eval-only (not real-time) |
| Recipient awareness | 4 types + relationship integration | No | No |
| Agent-to-agent trust | AgentTrustManager integration | No | No |
| Self-healing | Governed organic evolution | No | No |
| Per-reviewer model selection | Yes (Haiku/Sonnet) | N/A | N/A |

The Coherence Gate now occupies a unique position: deterministic safety (like guardrails) + semantic quality (like eval platforms) + relationship awareness (novel) + self-healing (novel). No single competitor covers this surface.

---

## Business Risk Assessment

### Reduced Risks (from Round 2)
- **Patch poisoning**: Governed by operator approval queue
- **Model vulnerability**: Addressed by per-reviewer model selection
- **Semantic evasion**: Detected by embedding comparison

### Remaining Risks (unchanged from Round 2, acceptable)
- **Enterprise readiness**: SOC2, SLA, dedicated infrastructure not addressed. Appropriate to defer — the technical controls provide a foundation.
- **Non-English quality**: Downgrade-to-warn approach is pragmatic. Market opportunity in multilingual reviewer prompts.

---

## Summary

The spec has reached a level of maturity that justifies implementation without further review rounds. The PEL adds deterministic guarantees that enterprise buyers need. Recipient-aware grounding with trust management is genuinely novel. The governed organic evolution system is the competitive moat. Cost model remains attractive (~$6-9/month per agent with Sonnet overrides).

Begin implementation.
