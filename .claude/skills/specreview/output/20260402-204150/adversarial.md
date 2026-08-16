# Adversarial Review — Round 6

**Review ID**: 20260402-204150
**Date**: 2026-04-02
**Spec**: Unified Threadline x MoltBridge x Instar (v0.5.0)
**Reviewer**: Red Team / Adversarial Specialist
**Prior Round**: Round 5 (8.05/10, all-conditional)
**Focus**: Verify v0.5.0 fixes for Argon2id salt, delegation depth, recovery fraud, Sybil defenses

---

## Approval Status: CONDITIONAL

---

## v0.5.0 Fix Verification

| Round 5 P0 | Fix in v0.5.0 | Verified | Notes |
|---|---|---|---|
| A-C1: Argon2id constant salt | Per-agent `recoverySalt` in `identity.json` | CONFIRMED | Correctly specified |
| A-C2: Delegation depth not capped | `max_delegation_depth: 1` in schema | CONFIRMED with gap | Field exists; enforcement chain not specified — see A6-C1 |

Both fixes are present. A-C2 has a second-order gap in enforcement specification.

---

## Critical Issues

### A6-C1: Delegation Depth — Grant-Hop Attack

**Likelihood**: Medium | **Impact**: High | **Priority**: HIGH

The spec doesn't define whether the depth counter is carried as a *signed claim from the issuer* or *self-reported by the requesting agent*. If self-reported, a `trusted` agent at depth=1 can issue a new grant with depth=0, then that agent issues at depth=1 — resetting the counter indefinitely. This is the OAuth 2.0 actor chaining attack (RFC 8693 section 8).

**Fix**: Specify that depth is issuer-signed and enforcer-verified, not requestor-reported. One paragraph in Section 3.6.

### A6-C2: Notification Channel DoS During Recovery Time-Lock

**Likelihood**: Medium | **Impact**: High | **Priority**: HIGH

The 24-hour recovery time-lock notifies via "Telegram, Slack, dashboard." An attacker with the recovery phrase can simultaneously attack notification channels (revoke Telegram bot token, suspend Slack webhook, DoS the relay) during the cancellation window. The legitimate agent never sees the alert; recovery proceeds.

**Fix**: Require at least one notification channel to be a local file write independent of network access; specify that "human confirmation" must use an out-of-band channel if primary channels are compromised.

### A6-C3: Blinded Attestation Timing De-Anonymization

**Likelihood**: Medium | **Impact**: Medium | **Priority**: MEDIUM-HIGH

Attestations submitted immediately after interaction are trivially attributed (Agent B interacts at time T, blinded attestation appears at T+delta -> attestor is obviously Agent B). At small network sizes (10-50 agents), k-anonymity is effectively 1-anonymity.

**Fix**: Enforce minimum k=5 before MoltBridge publishes aggregates, add mandatory 2-24h random submission jitter.

### A6-C4: Proof-of-AI is Economically Obsolete as Sybil Defense

**Likelihood**: Low-Medium | **Impact**: High | **Priority**: MEDIUM

At 2026 AI pricing (<$0.001/1000 tokens), a 1,000-agent Sybil network costs ~$0.50 in API calls to register. The collusion cluster detector (Louvain) can be evaded by interleaving fake agents with legitimate interactions.

**Fix**: Require a USDC deposit ($1.00, refundable after 90 days) at registration, or require cross-verification from one existing IQS>0.7 agent before appearing in discovery.

---

## Key Observations

- **A6-O1**: +/-30s clock skew tolerance is gameable on single-use tokens — consider +/-5s for `maxUses: 1` invitations
- **A6-O2**: Headless agents will accidentally log recovery phrases via `console.log(process.env)` — the spec needs an explicit "never log" warning
- **A6-O3**: `verified` attackers can pre-position messages in offline queues that deliver with priority on queue flush
- **A6-O4**: `legacyFingerprints` in Agent Card may publicly reveal migration status — inconsistent with authenticated-only `migrationStatus`
- **A6-O5**: 30-day migration deadline creates a known attack window; adversaries can time disruption attacks to coincide with day-29 deadline cliffs
- **A6-O6**: 100ms fast-solver threshold still hardware-absolute (Round 5 P1, unresolved) — legitimate M3 Max agents will be false-flagged

---

## Research Findings

- **Delegation depth attacks**: OAuth 2.0 actor chaining (RFC 8693 section 8) documents exactly the grant-hop pattern. Real-world precedent in Google Workspace delegation chains.
- **Recovery phrase social engineering**: Ledger phishing campaigns (2023-2025) demonstrate that time-locks are necessary but insufficient without channel-independent notification.
- **Sybil economics**: At current AI pricing, PoW + Proof-of-AI combined costs <$1 for 1000 agents. Economic deposit is the only proven Sybil defense at scale (Ethereum staking model).
- **k-anonymity in small networks**: Research shows k-anonymity degrades to 1-anonymity when N < 10k for timing-based deanonymization.

---

## Scalability Assessment

The highest-priority long-term threat is A6-C4 (Proof-of-AI Sybil): attack cost scales with AI pricing, which is declining rapidly. A6-C3 (attestation timing) is worst when the network is small — the k=5 threshold must be enforced from day one, not added later when the network has grown past the vulnerability window. All other issues are scale-neutral or self-correcting at larger network sizes.

---

## Recommendations (Priority Order)

1. Specify delegation depth as issuer-signed claim (A6-C1) — one paragraph in Section 3.6
2. Add network-independent notification channel for recovery alerts (A6-C2)
3. Add k=5 minimum and 2-24h jitter to blinded attestation spec (A6-C3)
4. Clarify `legacyFingerprints` auth-gating in Agent Card (A6-O4)
5. Add economic Sybil defense to MoltBridge registration (A6-C4)
6. Add "never log recovery phrase" explicit warning for headless deployments (A6-O2)
7. Mark 100ms fast-solver threshold as known limitation with deferred resolution (A6-O6)

---

## Score: 7.8/10

**Justification**: Round 5 P0 fixes (Argon2id salt, delegation depth field) are correctly implemented. However, the delegation depth enforcement mechanism has a second-order gap (grant-hop attack), recovery time-lock notifications are network-dependent (single point of failure), and blinded attestation provides false privacy guarantees at small network sizes. The Proof-of-AI Sybil defense is economically obsolete at 2026 pricing. These are addressable issues — none require architectural changes — but they represent real attack surfaces that a determined adversary would exploit.
