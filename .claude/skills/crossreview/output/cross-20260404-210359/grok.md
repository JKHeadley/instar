# Grok 4.1 Fast Review: rich-agent-profiles-spec.md

**Model**: grok-4-1-fast
**Date**: 2026-04-05
**Focus**: full document
**Score**: 9/10
**Status**: CONDITIONAL APPROVE

---

## Critical Issues

### 1. Human Approval Gap for Non-Instar Agents
Non-instar agents (Section 7) can bypass the human-in-the-loop gate that Section 2.4/3.4 mandates for all agents. The registration path goes straight to `POST /agent/profile` with a signed payload — no equivalent of the mandatory human review gate.

**Suggested fix**: Either document that non-instar agents self-publish without human review (acceptable if first-party claims carry no trust weight), or add a 24-hour pending state before Discovery Card becomes visible.

### 2. Timestamp Format Ambiguity
RFC 3339 allows milliseconds; the spec contradicts itself between sections (some show milliseconds, some don't). Different implementations will produce different canonical strings from the same moment.

**Suggested fix**: Enforce exactly `YYYY-MM-DDTHH:MM:SSZ` with a regex validation. No milliseconds, always Z suffix, never +00:00.

### 3. "Trusted" Visibility Tier Underspecified
The "trusted" tier requires IQS ≥ "medium" band AND prior interaction, but no IQS band definitions exist and "interacted with" is undefined. Creates inconsistent privacy enforcement across implementations.

**Suggested fix**: Define IQS band thresholds explicitly. Define "interaction" as: at least one completed Threadline message exchange or attestation.

## Strengths
- First-party vs third-party claim separation is the strongest design decision
- IQS independence from profile richness prevents gaming incentives
- A2A positioning as complementary layer is strategically correct
- Content-hash recompilation is elegant and cost-effective
- The allowlist model (ban USER.md, tag-gate MEMORY.md) is robust

## Unique Insights
- SSI/DID/Verifiable Credentials ecosystem framing — MoltBridge profiles could be expressed as VCs
- Neo4j-specific scaling recommendations with Cypher query patterns
- RFC 3339 interoperability landmine was not caught by prior reviews
- Recommended the spec explicitly define "interaction" for the trusted tier

## Recommendations (Prioritized)
1. Resolve the non-instar human approval asymmetry
2. Lock down timestamp format to exact regex pattern
3. Define IQS band thresholds and "interaction" for trusted tier
4. Consider expressing profiles as W3C Verifiable Credentials for ecosystem compatibility
5. Add Neo4j index recommendations for Discovery Card hot-path queries
