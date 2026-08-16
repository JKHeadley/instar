# Business Review: Seed Migration Spec — Round 2

**Reviewer**: Business Strategy & Product-Market Fit Specialist
**Date**: 2026-03-14
**Spec**: seed-migration.md (Draft v2, post-review)
**Round 1 Review**: 20260314-104223
**Round 1 Score**: 8/10 (CONDITIONAL)

---

### Round 2 Assessment

This is a substantially improved spec. The author addressed the two business-critical issues I raised, plus the majority of the cross-reviewer consensus findings from the synthesis. The v2 revision added architecture sections (triage granularity, tree query API, content integrity, cache strategy, input sanitization) that were notably absent in v1, and resolved all five open questions that previously represented deferral risk.

The business case is clearer, the risk profile is lower, and the implementation sequence is more rigorous. The net savings model now honestly accounts for triage overhead — a gap I and two other reviewers flagged. The token savings projection has been revised from the optimistic "~6,000 tokens/session" to the more accurate "~6,500-8,000 tokens/session" net of triage cost, which strengthens the spec's credibility.

My two Round 1 critical issues are assessed below.

---

### Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| Zero search count needs root cause analysis | **RESOLVED** | v2 includes a dedicated "Root Cause: Zero Search Count" paragraph in the Problem section. The explanation — tree shipped without a migration path, CLAUDE.md was never slimmed, agents had no reason to query a tree that competed with a complete monolith — is the correct diagnosis. It also acknowledges the important implication: the tree's retrieval quality is unvalidated at scale, and the test suite must stress-test retrieval accuracy before trusting it as primary. This is exactly the framing I asked for. |
| Anti-pattern loading timing is a live business risk | **RESOLVED** | v2 resolves this decisively. Design Principle 6 ("Training Override Anchoring") now codifies the business logic explicitly: critical anti-patterns must load from token one because they are the precondition for everything else working. The top 7 anti-patterns are hardcoded in the seed (40 lines, ~500 tokens). The remaining anti-patterns are loaded unconditionally via the behavioral layer at session start (Tier 3, ~800 tokens). Most importantly, v2 adds the line "They are never deferred to on-demand — behavioral guidance must precede behavior." This closes the open question cleanly and with the correct answer. |

Both issues are fully resolved. The spec went further than I required — it not only included the anti-patterns in the seed but added a Design Principle explaining *why*, and extended the architecture to include unconditional behavioral layer loading at session start for the secondary anti-patterns. This is the right structural enforcement over willpower.

---

### New Issues (if any)

#### 1. Remaining Open Questions Are Not Equivalent

The spec now separates "Resolved Design Decisions" from "Remaining Open Questions." The remaining five open questions (tree query observability, multi-machine sync, token budget enforcement, evolution system interaction, performance benchmarks) are correctly classified as lower priority than the five that were resolved.

However, two of these warrant business attention before Phase 6:

**Multi-machine tree sync** (Open Question 2) — The spec describes per-agent tree config stored in the agent's `.instar/context/` directory, which would be synced via git-sync. But the spec doesn't confirm this explicitly. When an agent runs across two machines and the tree config diverges temporarily (e.g., one machine applied an upgrade, the other hasn't yet), what does the agent on the stale machine see? If it serves stale capability docs, the business risk is an agent that confidently gives wrong instructions. This should be addressed before Phase 6 broad rollout, not left open.

**Token budget enforcement** (Open Question 3) — The spec defines `maxTokens` as a tree query parameter but never describes what happens when a retrieved context file exceeds it. Silent truncation is a coherence failure mode: the agent gets partial instructions, doesn't know they're partial, and acts on incomplete information. This needs a defined behavior (return partial + signal truncation, or return nothing + signal budget exceeded) before Phase 5. It's a user-facing failure mode that affects task completion rates.

Neither of these blocks Phase 5 (Echo pilot), but both should be resolved before Phase 6.

#### 2. Success Criteria: Net Savings Threshold May Be Too Optimistic

The spec sets success criterion 6 as "Net token savings > 40% per session." The revised cost table shows a range of 6,500-8,000 tokens/session net of triage overhead, against 17,600 tokens baseline — that's a 55-63% reduction at the low end, comfortably above 40%.

However, the triage cost estimate ("3 queries × 500-1,000 tokens each") is itself uncertain. It's labeled as an estimate with a note that Phase 2 must measure real numbers. If actual triage costs run higher — say, 5 queries averaging 1,500 tokens each — net cost climbs to ~12,500 tokens/session (29% savings), below the 40% threshold. The spec correctly gates proceeding to Phase 4 on updating the cost model with real Phase 2 measurements. But the 40% success threshold should be noted as contingent on Phase 2 validation, not treated as a confirmed baseline.

This is a low-risk concern — the architecture is sound regardless of the exact savings number — but setting a public success threshold that Phase 2 measurements might miss would be an unnecessary credibility risk.

#### 3. Phase 0 Is a Critical Path Change (Positive Observation)

The addition of Phase 0 (Triage Granularity Fix) as an explicit prerequisite is architecturally correct and a good change. However, it shifts the critical path: Phase 0 requires code changes to `TreeTriage.ts`, which means the "Phases 1-3 can proceed immediately" guidance from Round 1 synthesis is no longer fully accurate.

Phases 1 and 2 (creating context files and updating tree node config) are still additive and can proceed in parallel with Phase 0. But Phase 2 validation now depends on Phase 0 completion — you can't verify that "query about publishing returns only `capabilities.publishing`" until two-stage triage is implemented. Operators should be aware the critical path now runs Phase 0 → Phase 2 validation → Phase 3 test suite, not just Phase 1 → Phase 2 → Phase 3.

This isn't a problem, just a sequencing implication worth surfacing.

---

### Updated Approval Status: APPROVE

Both Round 1 critical issues are resolved. The spec is materially improved. The remaining open questions are correctly scoped as non-blocking for Phases 0-5. The architecture is sound, the test suite is rigorous, the rollback plan is credible, and the business case is honest about its uncertainties.

Conditions for Phase 6 (broad rollout):
1. Phase 2 triage cost measurements update the cost model before Phase 4
2. Multi-machine tree sync behavior defined (Remaining Open Question 2)
3. Token budget enforcement behavior defined (Remaining Open Question 3)

These are Phase 6 gates, not current blockers. Phases 0-5 can proceed.

---

### Updated Score: 9/10

**Justification**: The spec closed both business-critical gaps and went further — adding structural enforcement (Design Principle 6) rather than just answering the specific questions. The cost model is now honest about triage overhead, the open questions are correctly resolved or correctly deferred, and the phased approach with explicit gates is operationally mature. One point withheld for the two remaining open questions that could become Phase 6 blockers if not addressed before broad rollout, and for the 40% success threshold contingency that should be explicitly conditioned on Phase 2 measurement results.

This is ready to build.
