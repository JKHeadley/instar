# Gemini 3.1 Pro Review: rich-agent-profiles-spec.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-05
**Focus**: full document
**Score**: 8.5/10
**Status**: CONDITIONAL APPROVE

---

## Critical Issues

### 1. Signature vs. Selective Disclosure Paradox
The spec signs the full payload (Section 4.1) but strips fields by visibility tier on serve (Section 5.1). These are **cryptographically incompatible** — signatures will fail to verify after field stripping. A consumer receiving a Tier 1 Discovery Card with fields removed cannot verify the signature because it was computed over all fields.

**Suggested fix**: SD-JWT (Selective Disclosure JWT) or Merkle tree selective disclosure — sign the full payload but provide proofs for individual fields that can be verified independently.

### 2. Centralized Key Recovery
Manual admin phone/email verification for key compromise (Section 9) is a social engineering vector and a scalability bottleneck. One compromised admin account = ability to rotate any agent's keys.

**Suggested fix**: Decentralized recovery — cold-storage recovery key registered at signup. Recovery requires signatures from both the recovery key and the admin channel.

### 3. Thundering Herd Risk
Platform-wide updates (e.g., schema migration, capability taxonomy change) could trigger thousands of simultaneous `PUT /agent/profile` calls. The 24hr debounce is per-agent, not global.

**Suggested fix**: Client-side jitter (already in spec for compilation) + server-side write rate limiting with backpressure.

## Strengths
- IQS/richness decoupling is the strongest architectural decision in the spec
- Client-side compilation pipeline keeps MoltBridge stateless and platform-agnostic
- First-party vs third-party claim separation is well-designed
- USER.md ban as fail-safe PII protection is unusually thoughtful
- Three-tier progressive disclosure is the right pattern

## Unique Insights
- The selective disclosure paradox is a novel finding not caught by the 8-reviewer Claude panel
- Merkle tree approach for field-level verification is an elegant solution worth exploring
- The thundering herd scenario is distinct from the per-agent compilation spike the scalability reviewer flagged

## Recommendations (Prioritized)
1. Resolve signature/selective disclosure conflict before implementing visibility tiers
2. Replace centralized key recovery with cold-storage recovery key mechanism
3. Add global write rate limiting with backpressure for profile updates
4. Consider SD-JWT for the profile payload format (aligns with W3C VC ecosystem)
5. Define explicit cache invalidation push mechanism for relay nodes
