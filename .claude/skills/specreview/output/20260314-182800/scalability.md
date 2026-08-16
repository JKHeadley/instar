# Scalability Review: Seed Migration Spec — Round 2

**Reviewer**: Scalability & Infrastructure Specialist
**Spec**: `specs/seed-migration.md` (Draft v2, post-review)
**Round 1 Review**: 20260314-104223
**Review Date**: 2026-03-14

---

## Round 2 Assessment

The v2 revision is a substantial improvement. All four critical issues from Round 1 have been addressed — three fully, one partially with a credible deferral rationale. The authors also incorporated the synthesis's consensus findings: capability index in seed, many-small-files architecture, triage cost model gap, cache strategy definition, and triage granularity fix. This is a well-executed revision that treats the first-round feedback seriously.

The remaining scalability concerns are mostly deferred with explicit acknowledgment (shared caching at Phase 3, staggered rollout noted), which is an acceptable posture for the current scale. The spec is now more honest about its uncertainty — it removed the overconfident "17,600 → ~6,000" claim and replaced it with a range with explicit unknowns.

**No new blockers introduced by v2.** The changes are additive and correct direction. Two previously "recommendation" items have been partially addressed but warrant monitoring flags.

---

## Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| **1. LLM Triage Is an Unbounded Cost Multiplier** | RESOLVED | v2 adopts rule-based primary + LLM fallback. Cost table now shows triage overhead (~1,500-3,000 tokens/session). Note requires Phase 2 measurement to validate actual numbers before proceeding to Phase 4 — this is the right gate. |
| **2. Cache Invalidation Strategy Is Absent** | RESOLVED | Cache strategy is now fully specified: key = file path + modification time, TTL = 1hr (rule-based) / 30min (LLM), invalidation = file-change events, integrity = HMAC-stamped entries. Individual files per capability makes this coherent — file-level cache keys are simpler and more reliable than section-level keys. |
| **3. Single Context File Is a Scaling Bottleneck** | RESOLVED | v2 adopts per-capability files explicitly and enumerates six reasons (blast radius, versioning, cache coherence, least-privilege, HMAC simplicity, auditability). The Open Question is closed with the correct answer. ~35 individual files under `context/capabilities/`. |
| **4. Anti-Pattern Loading Strategy Is Unresolved** | RESOLVED | Top 7 critical anti-patterns are now explicitly listed and anchored in the seed permanently. Remaining anti-patterns, gravity wells, and principles move to Tier 3 — loaded unconditionally at session start via behavioral layer (~800 tokens), not deferred to on-demand. The "behavioral guidance must precede behavior" principle is now a named design principle (Principle 6). |

All four critical issues: RESOLVED.

---

## Resolution Quality Notes

### Issue 1 (Triage Cost): Resolution Is Structurally Sound But Validation Is Still Pending

The switch to rule-based primary triage eliminates the worst-case scaling scenario identified in Round 1. The cost table is now honest about uncertainty and explicitly gates Phase 4 on measuring real triage cost during Phase 2. The Category 6 performance tests include "Triage cost measurement" and "Rule-based vs LLM triage ratio" (>70% target).

**One monitoring flag:** The spec targets >70% rule-based resolution but doesn't define what happens if actual measurement shows, say, 45% rule-based. There's no decision tree for "if rule-based rate is lower than expected, then...". At current scale (3 agents), this is manageable — but the Phase 2 gate should include a specific threshold: if rule-based resolution rate < 60% on representative queries, the triage implementation needs rework before Phase 4. The spec implies this but doesn't state it. Recommend adding an explicit pass/fail criterion to the Phase 2 validation checklist.

### Issue 3 (Single File): Resolution Is Complete

The architecture table is now fully specified with individual files, node IDs, and file paths. The `context/` directory structure is diagrammed. This is the correct call and the implementation detail is sufficient to build from.

### Issue 4 (Anti-Patterns): Resolution Is Better Than Required

The spec didn't just add the top 5-7 anti-patterns to the seed — it elevated this to a first-class design principle (Principle 6: Training Override Anchoring) with an explicit rationale. The "anti-patterns are what make the rest of the architecture accessible — they are the precondition for everything else working" framing is correct and will prevent future attempts to move these to the tree for token savings. Good structural reinforcement.

---

## New Issues

### N1. Phase 0 Is Now a Prerequisite But Has No Scope or Effort Estimate

v2 adds a Phase 0 ("Triage Granularity Fix") as an explicit prerequisite before any other phase. This is correct — without two-stage triage, all 35 capability nodes load on any capability query, defeating the entire migration. However, Phase 0 currently has:

- No effort estimate (hours? days? sprint?)
- No risk assessment for the TreeTriage change
- No rollback plan if the two-stage implementation breaks existing (zero-count) tree queries
- No definition of what "extend TreeTriage to support two-stage resolution" requires at the code level

At current scale, this is a low-risk gap — Phase 0 is on Echo's own infrastructure. But it's the blocking prerequisite for Phase 1, so a surprise complexity discovery in Phase 0 blocks the entire migration. The spec should include at minimum: estimated complexity, the key architectural decision (how does stage-2 node selection receive the stage-1 layer result?), and a validation test that stage-1-only behavior (loading all nodes in a layer) is preserved as an explicit fallback.

**Severity**: Moderate. Won't cause scaling problems at current scale, but it's the first domino — underestimating Phase 0 delays everything.

### N2. Behavioral Layer Load (Tier 3) Token Budget Is Cumulative With Seed

v2 adds a Tier 3 behavioral layer (~800 tokens) that loads unconditionally at session start alongside the seed (~5,000 tokens). The capability index is also loaded at session start (~500 tokens via Resolved Q3). The combined baseline is now:

- Seed: ~5,000 tokens
- Behavioral layer (Tier 3): ~800 tokens
- Capability index (session-start load): ~500 tokens (already within seed's ~5,000)
- **Total baseline: ~5,800 tokens**

Plus triage overhead per on-demand query: ~1,500-3,000 tokens/session.

**Net range: ~7,300-8,800 tokens/session** (vs. the spec's "~6,500-8,000" range).

The cost table uses "~6,500-8,000" for the post-migration range, but this appears to include the behavioral layer and on-demand queries. Worth verifying the cost table arithmetic is consistent — the seed is listed as ~5,000, triage as ~1,500-3,000, which sums to ~6,500-8,000. If the behavioral layer (~800) is additive and not already inside the seed estimate, the true range is ~7,300-8,800. At 3 agents/4 sessions per day, this is a ~16% higher token cost than stated — not a blocker, but worth noting in the cost table for accuracy.

**Severity**: Low. Cosmetic accuracy issue in the cost table, not a functional problem.

### N3. Token Budget Enforcement for Oversized Context Files Is Still Open

The Remaining Open Questions section (Q3) acknowledges the question: "What happens when a retrieved context file exceeds the `maxTokens` budget? Truncation? Partial response? Warning?"

This is now explicitly deferred, which is better than in v1 where it wasn't acknowledged. However, from a scalability perspective, this matters: as individual capability files grow over time (new endpoints added to `publishing.md`, new parameters documented in `jobs.md`), files that start at 200 tokens can reach 800+ tokens in 6-12 months. If the tree silently truncates, agents get partial information without knowing it — a correctness failure that's hard to debug.

The v2 spec should specify at minimum: "If content exceeds maxTokens, the tree returns the full content and logs a warning. The caller is responsible for truncation decisions." Truncation should never happen silently inside the tree.

**Severity**: Low now, moderate at 10x scale when files have grown. This is a "note for Phase 3" item rather than a blocker.

---

## Positive Changes to Note

1. **Phase 6 staggered rollout** — explicitly added ("agents upgrade one at a time with validation gates, not all simultaneously"). This addresses Round 1 Recommendation #7 directly.

2. **Schema validation on upgrade script output** — Phase 6 now includes "Validates upgrade script output against a schema (prevents supply chain attacks via malicious CLAUDE.md content)." This addresses a gap identified in the synthesis but not in the scalability review specifically.

3. **Resilience Mode rename** — Adopted from synthesis. "Degraded Mode" is now "Resilience Mode" throughout.

4. **Deterministic vs LLM-graded test separation** — Category distinction is now explicit in the test suite (addressed Round 1 Recommendation #9). The "Rule-based vs LLM triage ratio" Category 6 test is new and valuable.

5. **Root cause analysis for zero-search-count** — The spec now includes a dedicated section explaining why the tree was never adopted. This addresses the synthesis's P2 recommendation and correctly identifies the adoption failure as a migration path problem, not a tree quality problem.

6. **Triage granularity addressed** — Phase 0 (new) directly addresses the synthesis's blocker B1. Two-stage resolution (layer → node) is the correct approach.

7. **Tree Query API defined** — The API section is now complete: endpoint, response format, confidence thresholds, triage method field. This addresses synthesis blocker B4 directly.

8. **Irrelevant result recovery path defined** — The spec now has a four-step recovery protocol (reformulate → check index → Quick Lookup Table → /capabilities). This addresses synthesis blocker B5.

9. **HMAC integrity defined** — Full implementation detail: HMAC-SHA256 on write, signature storage in `context/.integrity.json`, verification on read, fail-closed behavior, content framing with `<knowledge-fragment>` tags, HTML comment stripping. Addresses synthesis blocker B2.

---

## Updated Approval Status: APPROVE

The four critical issues from Round 1 are resolved. The three new issues identified in this round are low-to-moderate severity with no blockers. The spec is now structurally sound for implementation.

**Conditions for proceeding (not blockers, but gates):**

1. Before Phase 4: Validate actual triage cost in Phase 2. If rule-based resolution rate < 60% on representative queries, triage implementation needs rework before proceeding.
2. Phase 0 should add effort estimate and a fallback path if two-stage implementation is more complex than expected.
3. Token budget enforcement behavior (Q3) should be defined before Phase 5 (Echo migration) — silent truncation must not be the default.

---

## Updated Score: 9/10

**Round 1 score**: 7/10
**Round 2 score**: 9/10

**Justification**: The revision addressed every critical issue correctly and adopted the synthesis's consensus recommendations across the board. The architecture is now coherent: per-file capability storage, rule-based primary triage, defined cache strategy with HMAC integrity, critical anti-patterns in seed, behavioral layer unconditionally loaded, two-stage triage as a prerequisite. The cost model is honest about uncertainty and gates correctly on Phase 2 measurement before committing to Phase 4. The test suite is comprehensive and properly stratified (deterministic vs. LLM-graded).

The 1-point deduction is for Phase 0 underspecification (the prerequisite blocker with no scope definition) and the minor cost table accuracy gap. A 10/10 would require Phase 0 to have an effort estimate, complexity assessment, and rollback plan — and the cost arithmetic to be internally consistent. These are real gaps but small ones. The spec is ready to build from.
