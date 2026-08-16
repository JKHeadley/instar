# SpecReview Synthesis: Seed Migration — Round 2

**Review ID**: 20260314-182800
**Date**: 2026-03-14
**Round**: 2
**Spec Version**: v2 (post-Round 1 review)

## Overall Assessment

**Status**: READY
**Average Score**: 8.75 / 10
**Score Range**: 8 - 9

The v2 revision is a substantive, well-executed response to the Round 1 critique. All 5 P0 blockers from Round 1 are resolved. All 5 open questions from Round 1 are locked with principled answers. The two open conflicts (single vs. many files; session-start loading) are resolved with clear consensus. The spec moved from 8/8 CONDITIONAL to 6/8 APPROVE + 2/8 CONDITIONAL, with the average score rising from 7.0 to 8.75. No reviewer identified a new blocker.

The remaining conditions from the two CONDITIONAL reviewers (Security, Adversarial) are narrower than Round 1's conditions and can be addressed during implementation without blocking Phases 0-3. The spec is ready to build from.

### Score Movement (Round 1 -> Round 2)

| Reviewer | R1 Status | R1 Score | R2 Status | R2 Score | Movement |
|----------|-----------|----------|-----------|----------|----------|
| Security | CONDITIONAL | 6 | CONDITIONAL | 8 | +2 |
| Scalability | CONDITIONAL | 7 | APPROVE | 9 | +2 |
| Business | CONDITIONAL | 8 | APPROVE | 9 | +1 |
| Architecture | CONDITIONAL | 7 | APPROVE | 9 | +2 |
| Privacy | CONDITIONAL | 7 | APPROVE | 9 | +2 |
| Adversarial | CONDITIONAL | 6 | CONDITIONAL | 8 | +2 |
| DX | CONDITIONAL | 7 | APPROVE | 9 | +2 |
| Marketing | CONDITIONAL | 8 | APPROVE | 9 | +1 |

Every reviewer increased their score. The largest gains (+2 points) came from the four reviewers who had identified the most structural gaps in Round 1 (Security, Scalability, Architecture, Privacy, Adversarial, DX). The two reviewers with higher Round 1 scores (Business, Marketing) gained +1 each — their concerns were fewer and simpler to resolve.

## Round 1 P0 Issues: Resolution Status

### P0-1: Anti-Pattern Loading Strategy (7/8 reviewers flagged in R1)
**Status: FULLY RESOLVED — unanimous agreement across all 8 reviewers.**

The spec resolved this with a three-part strategy:
1. Top 7 critical anti-patterns hardcoded in seed (~500 tokens, always loaded)
2. Remaining anti-patterns loaded unconditionally via Tier 3 behavioral layer at session start (~800 tokens)
3. Design Principle #6 (Training Override Anchoring) codifies the reasoning: "behavioral guidance must precede behavior"

Multiple reviewers (Business, Architecture, Marketing) noted this resolution exceeded expectations — the spec didn't just answer the question, it elevated the answer to a first-class design principle that prevents future regression.

### P0-2: HMAC Integrity Verification on Reference File (5/8 reviewers flagged in R1)
**Status: FULLY RESOLVED — all reviewers confirm.**

The spec adopted per-file HMAC-SHA256 with signatures stored in `context/.integrity.json`, verified at every tree traversal, fail-closed on verification failure. The single monolith reference file was replaced by ~35 individual per-capability files, each independently signed. Content framing with `<knowledge-fragment>` tags and HTML comment stripping addresses the injection surface.

Two reviewers (Architecture, Adversarial) note the HMAC key is the agent's auth token, creating a key rotation fragility. This is a refinement, not a failure of the resolution.

### P0-3: Triage Granularity (Architecture blocker in R1)
**Status: FULLY RESOLVED — all reviewers confirm.**

Phase 0 is now a formal prerequisite: two-stage triage (layer -> node) using rule-based keyword matching at Stage 2. Validation criteria are concrete and measurable. The fix eliminates the fundamental flaw where any capability query loaded all 35 nodes.

### P0-4: Tree Query API (DX blocker in R1)
**Status: FULLY RESOLVED — all reviewers confirm.**

`GET /self-knowledge/search?q=<query>&maxTokens=<budget>` is fully specified with response schema including `nodeId`, `content`, `confidence`, `source`, `cached`, `triageMethod`, `totalTokens`, and `query`. Confidence tiers are defined with numeric thresholds (>=0.8 high, 0.5-0.79 medium, <0.5 low).

### P0-5: Irrelevant Result Recovery Path (DX blocker in R1)
**Status: FULLY RESOLVED — all reviewers confirm.**

Four-step fallback ladder: reformulate query -> check capability index -> Quick Lookup Table -> query `/capabilities` directly. Confidence scoring provides the signal that triggers the recovery path.

## New Consensus Findings (Round 2)

Issues that 3+ Round 2 reviewers independently identified as new concerns:

### 1. Token Budget Enforcement / Truncation Behavior Is Undefined (6/8 reviewers)
**Reviewers**: Security, Scalability, Business, Architecture, DX, Marketing

The most consistent new finding across Round 2. The `maxTokens` query parameter exists but the spec never defines what happens when retrieved content exceeds the budget. Silent truncation is the most likely default and the most dangerous outcome — an agent that receives partial capability documentation without knowing it's partial will act on incomplete information with full confidence.

**Consensus recommendation**: Add a `truncated: boolean` field to the API response schema. Never truncate silently. Either return full content with a budget-exceeded signal, or return nothing with an explicit indication. Resolve before Phase 5 (first real agent usage).

### 2. HMAC Key Coupled to Auth Token (4/8 reviewers)
**Reviewers**: Architecture, Adversarial, DX, Security (implicit)

Using the agent's auth token as the HMAC signing key creates two problems: (1) auth token rotation invalidates all HMAC signatures, causing all tree queries to fail until the manifest is regenerated; (2) an attacker with read access to `config.json` (same directory as context files) can forge valid HMACs, defeating the integrity mechanism entirely.

**Consensus recommendation**: Use a dedicated, non-rotating signing key stored separately from the auth token. Document the threat model explicitly: HMAC protects against write-only attackers, not read+write attackers.

### 3. Phase 0 Is Underspecified (3/8 reviewers)
**Reviewers**: Scalability, Architecture, Business

Phase 0 is the critical-path prerequisite for the entire migration but has no effort estimate, no rollback plan, and minimal implementation detail. A surprise complexity discovery in Phase 0 blocks everything.

**Consensus recommendation**: Add effort estimate, key architectural decision points, and a validation test harness for Phase 0 before beginning Phase 1.

### 4. Evolution System Interaction Remains an Open Security Question (3/8 reviewers)
**Reviewers**: Security, Adversarial, Marketing

Evolution proposals are generated by LLM sessions. If a session is manipulated (e.g., via prompt injection from a compromised Telegram message) and submits an evolution proposal that modifies a tree node, the attacker bypasses HMAC protection — because HMAC signs whatever the writer writes, including legitimately-signed but behaviorally-poisoned content.

**Consensus recommendation**: Evolution proposals that modify tree nodes must be gated on human confirmation (same mechanism as TreeGenerator regeneration), not auto-approved by the evolution-review job. Resolve before Phase 4.

### 5. Cost Table Arithmetic Is Inconsistent (3/8 reviewers)
**Reviewers**: Scalability, Architecture, Business (noted)

The spec lists net per-session cost as ~6,500-8,000 tokens, but the Tier 3 behavioral layer (~800 tokens) appears additive to the seed (~5,000) and is not clearly included in the estimate. True range may be ~7,300-8,800 tokens. The 40% savings success criterion still passes at 8,800 tokens (50% savings vs. 17,600 baseline), but the cost table should be internally consistent.

## Remaining Conditional Issues

### Security (CONDITIONAL -> full APPROVE requires):
1. Evolution proposal gate: tree-modifying proposals must require human confirmation before Phase 4
2. Token budget truncation signal: define truncation behavior before Phase 5
3. Confirm `resolvePath()` code update (path traversal fix) at Phase 0
4. Hardcoded safety baseline (3 in-memory rules) — low severity, recommended but not blocking

### Adversarial (CONDITIONAL APPROVE -> full APPROVE requires):
1. Document HMAC threat model: explicitly state that auth-token-as-key does not protect against read+write attackers (before Phase 4)
2. Content framing tag injection: escape `</knowledge-fragment>` from content before inserting into frames (before Phase 4)
3. Upgrade script schema must enforce path constraints (relative paths within `.instar/context/` only) before Phase 6

## New Issues Summary (Prioritized)

| Priority | Issue | Source Reviewers | Phase Gate |
|----------|-------|------------------|------------|
| P1 | Token budget truncation behavior undefined | Security, Scalability, Business, Architecture, DX, Marketing | Before Phase 5 |
| P1 | HMAC key coupled to auth token (rotation + threat model) | Architecture, Adversarial, DX, Security | Before Phase 4 |
| P1 | Evolution proposal gate for tree-modifying changes | Security, Adversarial, Marketing | Before Phase 4 |
| P2 | Phase 0 underspecified (effort, rollback, test harness) | Scalability, Architecture, Business | Before Phase 1 |
| P2 | Content framing tag injection (`</knowledge-fragment>` escaping) | Adversarial | Before Phase 4 |
| P2 | Cost table arithmetic inconsistency (Tier 3 ~800 tokens not included) | Scalability, Architecture | Before Phase 2 validation |
| P2 | Stale content version mismatch (no schema version in context files) | Architecture | During Phase 2 |
| P2 | Upgrade script schema path constraints undefined | Adversarial | Before Phase 6 |
| P2 | Multi-machine tree sync behavior undefined | Business | Before Phase 6 |
| P2 | Shadow mode pass/fail criteria undefined | Marketing, Privacy | Before Phase 5 |
| P2 | Phase ordering: scaffold (Phase 4) before pilot (Phase 5) | DX | Recommendation |
| P3 | Two-stage triage tie-breaking / multi-node query behavior | Architecture, Adversarial | During Phase 2 |
| P3 | Shadow mode log isolation (should not be queryable by tree) | Privacy | During Phase 3 |
| P3 | LLM-graded test data privacy (strip auth tokens before sending to Haiku) | Privacy | During Phase 3 |
| P3 | "Behavioral layer" needs user-facing name for upgrade communications | Marketing | Before Phase 6 |
| P3 | Competitive positioning in operator announcement | Marketing | Before Phase 6 |
| P3 | Hardcoded in-memory safety baseline (3 rules) | Security | Recommended |
| P3 | Capability index must include ALL Tier 2 nodes | Architecture | During Phase 1 |
| P3 | File-watching vs. write-time cache invalidation mechanism | Architecture | During Phase 2 |
| P3 | Markdown injection variants (YAML front matter, system-prompt-like lines) | Architecture | During Phase 2 |

## Convergence Status

| Metric | Round 1 | Round 2 |
|--------|---------|---------|
| APPROVE | 0/8 | 6/8 |
| CONDITIONAL | 8/8 | 2/8 |
| BLOCK | 0/8 | 0/8 |
| Average Score | 7.0 | 8.75 |
| Score Range | 6-8 | 8-9 |
| P0 Issues | 5 | 0 |
| Open Conflicts | 2 | 0 |

**Convergence**: CONVERGED

The review panel has converged. All 5 P0 issues from Round 1 are resolved. Both open conflicts are resolved. The score range has narrowed from 2 points (6-8) to 1 point (8-9). The two remaining CONDITIONAL reviewers (Security, Adversarial) have narrow, specific conditions that align with concerns shared by the APPROVE reviewers — there is no disagreement about what needs fixing, only about whether the fixes are blocking or advisory.

No Round 3 is needed. The remaining issues can be tracked as implementation tasks with phase gates.

## Phase Gates

### Phase 0 (Triage Granularity Fix) — CLEARED TO PROCEED
- Add effort estimate and rollback plan (P2, recommended before starting)
- Add a Phase 0 validation test harness (P2, recommended)
- Confirm `resolvePath()` code fix (Security condition)

### Phase 1 (Context File Creation) — CLEARED TO PROCEED
- Ensure capability index includes ALL Tier 2 nodes (P3)
- No blockers

### Phase 2 (Tree Node Configuration + Validation) — CLEARED TO PROCEED
- Validate actual triage cost; if rule-based rate < 60%, rework before Phase 4
- Update cost table arithmetic to include Tier 3 (~800 tokens)
- Address stale content versioning
- Define tie-breaking for multi-node Stage 2 matches

### Phase 3 (Test Suite) — CLEARED TO PROCEED
- Define token budget truncation behavior before test infrastructure ships
- Shadow mode log isolation
- LLM test data privacy filtering
- Shadow mode pass/fail criteria

### Phase 4 (Scaffold Template) — GATED
Must resolve before proceeding:
- HMAC key: use dedicated signing key, not auth token (P1)
- Evolution proposal gate: human confirmation for tree-modifying proposals (P1)
- Content framing tag escaping (P2)
- Document HMAC threat model (Adversarial condition)

**Recommendation (DX)**: Swap Phase 4 and Phase 5 — let the Echo pilot inform the scaffold template design.

### Phase 5 (Echo Migration + Shadow Mode) — GATED
Must resolve before proceeding:
- Token budget truncation behavior defined (P1)
- Shadow mode pass/fail criteria defined (P2)

### Phase 6 (Broad Rollout) — GATED
Must resolve before proceeding:
- Upgrade script schema with path constraints (P2)
- Multi-machine tree sync behavior defined (P2)
- User-facing communication materials written (Marketing)
- All remaining open questions resolved
- Phase 2 triage cost measurements validate cost model

### Phase 7 (CLAUDE.md Slim-Down) — No new gates from Round 2

## Next Steps

1. **Begin Phase 0 immediately.** The spec is approved for implementation. Phase 0 is the critical path — add an effort estimate and validation harness, then build the two-stage triage.

2. **Begin Phases 1-2 in parallel with Phase 0.** Context file creation and tree node configuration are additive and non-destructive. Phase 2 validation depends on Phase 0 completion.

3. **Track the 3 P1 issues as implementation prerequisites for Phase 4:**
   - Token budget truncation behavior
   - HMAC key decoupling from auth token
   - Evolution proposal human confirmation gate

4. **No Round 3 review is needed.** The panel has converged. The remaining issues are implementation refinements with clear phase gates, not architectural questions requiring further review.

5. **Before Phase 6:** Write operator communication materials (upgrade announcement, changelog, upgrade guide). The spec now contains all narrative ingredients — Training Override Anchoring, Resilience Mode, honest cost model, rollback-first safety story. Assembly required.
