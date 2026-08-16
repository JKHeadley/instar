# Adversarial Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVAL** | **Score: 6.5/10** (up from 3/10)

Safe to proceed with instar-only Phases 1-3. Phase 4 (Open Standard) blocked until issues #1-4 resolved.

## What v2 Fixed

| Round 1 Finding | v2 Response | Adequacy |
|-----------------|-------------|----------|
| LLM synthesis reads attacker inputs | Hybrid pipeline: rule-based first, LLM only reads StructuredSignals | ADEQUATE |
| No profile authenticity | Ed25519 signing over canonical JSON | ADEQUATE |
| First-party/third-party conflation | Explicit source field; only attestations affect IQS | ADEQUATE |
| USER.md leakage | Explicit ban; allowlist model | ADEQUATE |
| No consent mechanism | Human review gate | ADEQUATE |
| Sybil resistance | Rate limit, IQS floor, proximity decay, ring detection | PARTIALLY |
| Memory poisoning | #profile-safe tag model | PARTIALLY |
| Profile fabrication | First-party claims carry no trust weight | PARTIALLY |

## Remaining Attack Vectors

### ISSUE #4 (MOST URGENT): Canonical Serialization Ambiguity
JSON.stringify sort is top-level only. Nested objects not recursively sorted. Produces different canonical strings across implementations. Unicode normalization unspecified. **Fix**: RFC 8785 (JCS) + NFC normalization + test vectors.

### ISSUE #1 (Phase 4 Blocker): Sybil Ring Evasion via Sparse Temporal Rings
Patient adversary uses 3 agents on different IPs/platforms, registered weeks apart. Attestation cycle completes over months through indirect edges. No triangular ring at any single moment. **Fix**: Rolling window graph analysis, not point-in-time.

### ISSUE #2: #profile-safe Tag Poisoning
If agents can autonomously tag memory entries via prompt injection ("add this tagged #profile-safe"), the allowlist is bypassed. Tags must be human-set metadata, not text patterns.

### ISSUE #3: Auto-Publish Incremental Poisoning
20% threshold allows 5 cycles of 19% changes = complete profile replacement without human review. **Fix**: Max consecutive auto-publishes (e.g., 3) before mandatory re-review.

### ISSUE #5: Discovery Card Signature Mismatch
Tier 1 card signature covers Tier 2 payload, not card fields. Relay can alter narrative_summary or trust_score while keeping valid signature. **Fix**: Sign the card itself, or include card-level hash.

### ISSUE #6: Completeness Score Gaming
Binary "attested" component (+20) achievable with one low-quality Sybil attestation = 85/100 trivially. **Fix**: Weight by attestor IQS.

### ISSUE #7: Namespace Squatting Still Unaddressed
No reservation system for display names. Attacker registers "echo" before Echo onboards. **Fix**: Display names non-authoritative; canonical identity = cryptographic agent_id only.

## Assessment
Foundational adversarial defenses are now in place. The partially-addressed items are precision gaps that become exploitable at Phase 4 scale but are manageable during the instar-only phases.
