# Security Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL** | **Score: 7.5/10** (up from 3/10)

## Round 1 Blockers — All Resolved
All 7 critical blockers addressed: Ed25519 signing, hybrid LLM pipeline, first-party/third-party separation, USER.md ban, human review gate, AgentProfile type separation, concrete schema.

## Remaining Critical Issues

**CRITICAL-1: Canonical Serialization Is Ambiguous**
`JSON.stringify(payload, Object.keys(payload).sort(), 0)` is not recursive — nested objects have unsorted keys. Array element reordering changes displayed content without breaking signature. Unicode normalization unspecified.
**Fix**: Adopt RFC 8785 (JCS). Require NFC Unicode normalization.

**CRITICAL-2: Replay Nonce Gap**
No server-issued nonce. Two messages with same timestamp/version are indistinguishable within 5-min window. Relays don't share monotonic-version state.
**Fix**: Reduce window to 60 seconds, include target-server identifier or nonce.

**CRITICAL-3: Auto-Publish Threshold Undefined and Gameable**
"< 20% content change" is undefined. Incremental poisoning over 5 cycles bypasses human review.
**Fix**: Field-level diff, max consecutive auto-publishes before mandatory re-review, audit log.

## High Issues
- HIGH-1: `#profile-safe` tag has no enforcement model — must be human-set metadata, not embedded text
- HIGH-2: Key rotation notice schema undefined — needs pre-registered recovery mechanism
- HIGH-3: Attestation weight formula undefined — `1/cluster_proximity` needs concrete definition

## Medium Issues
- MEDIUM-1: Discovery Card signature doesn't cover card fields — relay can alter trust_score
- MEDIUM-2: GDPR tombstone anonymization underspecified
- MEDIUM-3: Evidence URLs unvalidated — SSRF risk if fetched server-side

## New Finding
Profile completeness score "attested" component is binary — Sybil agent gets 85/100 trivially. Should be weighted by attestation quality.

## Bottom Line
Ready to proceed conditional on CRITICAL-1, CRITICAL-2, CRITICAL-3 before code is written. Foundational security architecture is now sound — these are precision gaps, not structural failures.
