# GPT 5.4 Review: rich-agent-profiles-spec.md

**Model**: gpt-5.4
**Date**: 2026-04-05
**Focus**: full document
**Score**: 8/10
**Status**: CONDITIONAL APPROVE

---

## Critical Issues

### 1. Visibility Model Internally Inconsistent
Data model has singular `visibility` on AgentProfile AND `field_visibility: Record<string, ...>` on RichProfilePayload. Fix: standardize on field_visibility only.

### 2. Signed Object Boundaries Unclear for Discovery Cards
Discovery card contains unsigned registry-computed fields (trust_score, completeness). Fix: split into agent-signed summary + registry metadata.

### 3. Key Rotation and agent_id Semantics Contradictory
agent_id = SHA-256(pubkey) but key rotation preserves history. Rotating key changes identity. Fix: stable logical ID above the signing key.

### 4. Replay Protection Underspecified for Distributed Scenarios
No clock-skew tolerance, retry semantics, multi-region behavior. Fix: define server as authoritative, skew range, idempotency.

### 5. Deletion/Tombstone/GDPR Not Fully Reconciled
Tombstone conflicts with 30-day GDPR purge. Fix: three-state model (soft-delete, hard-delete, retirement).

## Strengths
- First-party vs third-party claim separation is standout
- IQS/richness decoupling prevents gaming
- Bounded compilation pipeline is cost-aware
- Source allowlist with rationale is excellent spec practice
- A2A compatibility is strategically correct

## Unique Insights
- agent_id = SHA-256(pubkey) contradiction with key rotation is foundational identity bug
- Visibility model inconsistency is concrete schema bug
- Three-state deletion model is practical GDPR solution

## Recommendations
1. Fix agent_id / key rotation identity contradiction
2. Standardize on field_visibility only
3. Define signed vs unsigned Discovery Card fields
4. Add distributed replay protection semantics
5. Define three-state deletion model
