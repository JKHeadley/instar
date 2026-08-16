# Architecture Review: Coherence Gate — Round 3

**Reviewer**: Systems Architect
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 8.5/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 9.0/10 (+0.5 from Round 2)

---

## Round 2 P1 Resolution

All Round 2 P1 items that relate to architecture are addressed:

### Per-Reviewer Model Config — Clean Implementation
`reviewerModelOverrides` in config (lines 265-267) with fallback to `reviewerModel`. The `CoherenceReviewer.ts` base class calls Haiku (or Sonnet per override) via `AnthropicIntelligenceProvider`. No architectural complexity — just a config lookup before the API call.

### Semantic Evasion Detection — Orthogonal Module
The embedding comparison (lines 895-906) runs only on revisions and is logically separate from the review pipeline. It reads the blocked message and revised message, computes similarity, and logs results. This can be implemented as a post-review hook in the revision flow without modifying the core pipeline. Clean separation.

---

## Assessment of New Additions

### Policy Enforcement Layer (PEL) — Correct Architectural Position

The PEL sits before the LLM pipeline (lines 63-78 in the architecture diagram). This is the correct position:

```
Request → PEL (deterministic, <5ms) → Gate (LLM, ~1s) → Specialists (LLM, ~2-3s) → Verdict
```

Key architectural properties:
- PEL is synchronous, deterministic, and fast — no network calls
- PEL blocks short-circuit the entire pipeline (saves cost when they fire)
- PEL is independent of LLM pipeline availability — runs even when Haiku is down
- PEL respects the same response contract as LLM reviewers (same `pass/feedback/violations` shape)

The separation between PEL (hard policy, deterministic) and LLM reviewers (soft quality, probabilistic) is architecturally clean. They compose naturally: PEL provides the safety floor, LLM reviewers provide the quality ceiling.

### Failure Mode Differentiation — State Machine Confirmation

The 6 failure classes (lines 811-824) map naturally to states in the CoherenceGate state machine (which Round 2 recommended implementing as an explicit state machine):

```
PENDING → PEL_CHECK → [PEL_BLOCKED | GATE_CHECK] → [GATE_SKIP | SPECIALIST_FAN_OUT]
  → [ALL_PASS | BLOCKED | PARTIAL_TIMEOUT | INFRASTRUCTURE_OUTAGE | RETRY_EXHAUSTION]
  → [DELIVER | BLOCK_AND_FEEDBACK | QUEUE | OPERATOR_HOLD | DELIVER_WITH_WARNING]
```

The spec doesn't explicitly call this a state machine, but the failure classes define the state transitions clearly. Implementation as an explicit state machine is straightforward.

The distinction between retry exhaustion on tone vs accuracy/alignment (line 820) adds a branching state: `RETRY_EXHAUSTION → [AUTO_DELIVER | OPERATOR_HOLD]` based on violation category. Clean.

### RecipientResolver — New Component, Clean Integration

`RecipientResolver.ts` (lines 1306-1311) is a new component that:
1. Queries RelationshipManager by `recipientId`
2. Queries AgentTrustManager for agent recipients
3. Returns structured context with fallback to conservative defaults

This is a facade over two existing systems (RelationshipManager, AgentTrustManager). It resolves once per review request and passes the context to relevant reviewers. No coupling between reviewers and the resolution logic.

**Concern**: What happens when RelationshipManager is unavailable (e.g., during startup before relationships are loaded)? The spec says "falls back to conservative defaults for unknown recipients" (line 1311). This is correct — but the fallback should be documented as equivalent to `external-contact` behavior (maximum strictness), not a silent degradation.

### Information Leakage Reviewer — Well-Scoped

The new `information-leakage.ts` reviewer (line 1303) is scoped exclusively to agent-to-agent communication. It uses the AgentTrustManager trust level to determine what content categories can be shared. This avoids adding overhead to user-facing messages while protecting the agent-to-agent boundary.

### Context Window Management — Smart Collapse

The collapse format (lines 908-918) compresses prior feedback chains into one-line summaries. This is architecturally significant because it prevents the revision loop from degrading generation quality through context bloat. Implementation is in the stop hook feedback composition — the server returns collapsed feedback, the hook passes it to Claude.

### Operator Governance for Patches — File-Based, Discoverable

The patch proposal system (lines 1097-1167) follows the same convention-over-configuration pattern as custom reviewers and skills:
- Proposals in `.instar/state/reviewer-patch-proposals/`
- Approved patches in `.instar/state/reviewer-patches/`
- Auto-discovery at server startup
- API endpoints for management

This is consistent with the rest of the architecture. No new patterns introduced.

### Per-Recipient Review History — Extension of Existing

Adding `recipientId` to review history (line 1339) and per-recipient-type breakdown to stats (line 1347) extends existing data structures. No schema changes needed beyond adding optional fields to the review log entries.

---

## Architectural Completeness Check

The implementation plan (lines 1258-1370) now includes:

| Component | File | Dependencies | Status |
|-----------|------|-------------|--------|
| PolicyEnforcementLayer | `src/core/PolicyEnforcementLayer.ts` | Config | New in Round 3 |
| CoherenceGate | `src/core/CoherenceGate.ts` | PEL, Reviewers, RecipientResolver | Updated |
| CoherenceReviewer | `src/core/CoherenceReviewer.ts` | AnthropicIntelligenceProvider | Updated (model overrides) |
| 8 Reviewers | `src/core/reviewers/*.ts` | Base class | +1 (information-leakage) |
| RecipientResolver | `src/core/RecipientResolver.ts` | RelationshipManager, AgentTrustManager | New in Round 3 |
| CustomReviewerLoader | `src/core/CustomReviewerLoader.ts` | File system | Unchanged |
| Stop hook | `coherence-gate.js` | Server endpoint | Unchanged |
| Routes | `/review/evaluate`, `/review/test`, `/review/history`, `/review/stats` | CoherenceGate | Updated |
| Governance routes | `/coherence/proposals`, `/coherence/health` | Patch system | New in Round 3 |

All components have defined interfaces and clear dependencies. No circular dependencies. The component graph is a DAG.

---

## Remaining Observations

### 1. RecipientResolver Fallback Behavior
Should be explicitly documented as "unknown recipient = external-contact strictness" in the implementation plan. The spec implies this but doesn't state it definitively.

### 2. State Machine Implementation
Round 2 recommended implementing CoherenceGate as an explicit state machine. The failure mode differentiation in Round 3 makes this even more appropriate. 6 failure classes × 2 channel types = 12 potential state transitions. An explicit state machine with named states and transitions is more maintainable than nested if/else.

### 3. Phase Numbering
Minor: The implementation plan has two "Phase 1" items (lines 1258, 1327 uses "Phase 2" for hook integration) and Phase 3/4 numbering is clean. The route numbering within phases is non-sequential (7→8→11→12→13→14→11→12). This is cosmetic but worth fixing before implementation to avoid confusion.

---

## Summary

The architecture is complete, clean, and ready for implementation. The PEL adds a deterministic layer that complements the LLM pipeline without architectural complexity. RecipientResolver is a clean facade. Failure mode differentiation maps naturally to state machine transitions. The governance system follows existing conventions. No new architectural patterns were introduced — everything composes with the existing design.

The spec is implementation-ready.
