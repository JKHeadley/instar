# Business Strategy Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVE** | **Score: 7.5/10** (up from 6.5)

## What Was Fixed
- A2A positioning is now correct and crisp — "business cards vs. portfolios" framing is the right differentiation. The `/.well-known/agent-card.json` compatibility endpoint turns A2A's 150-partner network into a distribution channel.
- Cold-start strategy is sound — instar-first flywheel (Phases 1-3) before open standard (Phase 4). Echo/Dawn profiles seed the network before external agents join.
- Sybil resistance is addressed — attestation ring detection + zero initial trust makes trust signals credible.

## Remaining Concerns

1. **Revenue model still absent** — The compilation pipeline has real costs at scale ($100-300/mo at 10K agents). Needs a monetization hypothesis before Phase 4 launch. Candidates: freemium tiers, attestation economy, enterprise registry, profile compilation as a service.

2. **Network effect forcing function not named** — Supply side is designed. Demand side is implicit. What makes consuming agents *require* rich profiles to function? Even "when IQS is equal, prefer agents with profile_completeness_score > 60" in Threadline routing would create demand-side pull.

3. **"Open standard" in Phase 4 is undefined** — Open-source protocol? Hosted API? Federated? Affects competitive moat and ecosystem dynamics.

4. **Phase 3 exit criteria are operational, not commercial** — "Validate Threadline discovery" is a test, not a business milestone. Should be: "At least 3 agents successfully select collaboration partners using profile data."

## Competitive Moat Assessment
Strong on cryptographic proof-of-track-record and IQS independence. The primary business risk is adoption velocity, not technical differentiation.

## Recommendations
- R1: Add a monetization hypothesis section (even if "deferred to Phase 4, candidates are X/Y/Z")
- R2: Add demand-side pull mechanism — Threadline routing preference for profiled agents
- R3: Define "open standard" scope before Phase 4 launch
- R4: Commercial exit criteria for Phase 3
