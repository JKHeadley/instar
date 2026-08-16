# Marketing Review: Seed Migration / Self-Knowledge Tree — Round 2
**Reviewer**: Marketing Strategy & Brand Positioning
**Spec**: `specs/seed-migration.md` (v2, post-review)
**Date**: 2026-03-14
**Round**: 2 (following Round 1: 20260314-104223)

---

### Round 2 Assessment

The revised spec is substantially improved from a marketing standpoint. The author has clearly read the Round 1 review and acted on the highest-priority concerns: "Degraded Mode" is now "Resilience Mode," the anti-pattern loading question is resolved with principled framing, the cost model has been corrected to include triage overhead, and the zero-search-count issue now has a documented root cause. The spec is no longer primarily an engineering document with marketing concerns tacked on — it has integrated the positioning concerns into its architecture language.

The single most significant addition is **Design Principle 6: Training Override Anchoring**. This principle does something Round 1 recommended but didn't expect the spec to supply: it gives the user-facing narrative a hook. "Your agent now has behavioral reflexes it never has to look up" is a more compelling story than "we reduced context tokens." The principle explains *why* the architecture looks the way it does in terms that agent operators can understand and trust.

The spec is ready to ship from a marketing standpoint, with one outstanding item: the user-facing communication materials (announcement, changelog, upgrade guide) still need to be written. The spec now contains all the narrative ingredients — the doctor analogy framing is implied by Training Override Anchoring, the Resilience Mode reframe is done, the cost model is honest, the rollback story is present, the test suite depth is documented. None of this has been assembled into operator-facing language yet. That work must happen before Phase 6 broad rollout, not after.

---

### Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| **"Migration" naming triggers anxiety** | RESOLVED | "Migration" is appropriately confined to the spec's technical context. The user-facing framing is now structured around "Resilience Mode," "Capability Index," and "Seed + Tree" — none of which carry disruption anxiety. The spec itself acknowledges in Phase 6 that upgrade messaging should lead with safety. |
| **"Degraded Mode" label should be reframed** | RESOLVED | Renamed to "Resilience Mode" throughout. Principle 2 is now explicitly titled "Resilience by Default" and the failure mode table uses "Resilience Mode" consistently. The framing — "not a degraded state, but a designed fallback that preserves core functionality" — is exactly right. This is now a feature, not a failure label. |
| **65% savings should be a benefit, not a raw number** | RESOLVED | The cost model has been corrected to include triage overhead (~1,500-3,000 tokens per session). The net savings figure dropped from ~65% to a more honest 55-63%. More importantly, the spec explicitly states: "Actual triage cost must be measured during Phase 2 validation and the savings model updated with real numbers before proceeding to Phase 4." This is honest accounting. The raw numbers are still present (appropriate for a technical spec) but no longer overstated. The narrative implication — lead with coherence improvement, not cost — is embedded in the architecture by leading with identity and behavioral integrity over efficiency. |
| **"Your agent now searches instead of knowing" framing risk** | PARTIALLY RESOLVED | Design Principle 6 (Training Override Anchoring) pre-empts this concern at the architectural level: it explains that the seed loads behavioral reflexes unconditionally. However, the user-facing version of this explanation (the "doctor analogy" recommended in Round 1) still does not exist. The spec gives engineers the right mental model. Agent operators who don't read the spec still need that 2-paragraph narrative. The ingredients are here; the dish hasn't been cooked. |
| **Test suite should be surfaced as a trust asset** | PARTIALLY RESOLVED | The test suite is now more comprehensive (7 categories, expanded test cases, explicit split into deterministic vs. LLM-graded). The spec documents it well internally. It is not yet referenced in any operator-facing context. Round 1 recommended including it in the upgrade announcement: "We ran your agent through 30+ scenarios..." That specific language still needs to be written. But the underlying asset is now stronger and better organized. |
| **Rollback message must lead in operator communication** | PARTIALLY RESOLVED | Phase 6 now specifies a structured upgrade guide with backup creation, validation, and staggered rollout. The rollback is now versioned (tree config + context files + CLAUDE.md restored together). This is a meaningful improvement. The operator announcement itself still needs to follow the structure recommended in Round 1: lead with rollback safety, then explain what changed. The spec sets up the content; the communication hasn't been drafted. |
| **Open Question 5 (anti-pattern loading) must be resolved before shipping** | RESOLVED | Fully resolved and with better framing than Round 1 recommended. The spec doesn't just say "top 5-7 stay in seed" — it names them explicitly, explains WHY (Training Override Anchoring principle), and explains the consequence if they're absent (agent reverts to trained defaults). This is the most significant improvement in the spec. The resolution is principled, not just pragmatic. |
| **"Zero search count" should not appear in user communication** | RESOLVED | The spec now includes a full root cause analysis section: the tree shipped without a migration path, so CLAUDE.md was never slimmed. This is the correct internal framing. The spec also notes this means tree retrieval quality is unvalidated at scale — an honest acknowledgment that the test suite must address. The user-facing framing remains correct: "the infrastructure was built first; this migration activates it." |
| **Metaphor family overloaded** | RESOLVED | The spec has implicitly simplified. Seed and Tree are the two primary terms in the architecture section. "Nodes" and "layers" appear in technical sections where they're appropriate. The user-facing summary (Tier 1/2/3 table, Resilience Mode table, success criteria) uses plain language throughout. No further simplification needed. |
| **Competitive positioning underexploited** | UNRESOLVED | The spec remains silent on competitive landscape. This is acceptable for a technical spec — competitive positioning belongs in marketing materials, not implementation documents. Flagging as unresolved because it should appear in the external announcement, not because the spec needs it. The positioning statement ("Most agent frameworks treat knowledge as a static document. Instar treats it as a living system.") is still available and still unused. |

---

### New Issues

#### 1. Remaining Open Questions Are Now a Marketing Liability

The spec has moved its original 5 open questions to "Resolved Design Decisions" — a clear improvement. But 5 new open questions remain at the end. Two of them have direct user experience implications:

**Q3 (Token budget enforcement)**: What happens when a retrieved context file exceeds `maxTokens`? Truncation? Partial response? If an agent silently receives partial information about a capability (because the file exceeded budget), it may behave incorrectly in ways the operator can't diagnose. This needs a defined answer before the spec goes to broad rollout.

**Q4 (Evolution system interaction)**: Can evolution proposals modify tree nodes? This has integrity implications beyond security — from a user trust standpoint, knowing that an agent can propose changes to its own knowledge tree requires a clear governance story. Operators who understand that agents can evolve will want to know: "can my agent change what it knows about itself?" If yes, is there human approval required? The spec should answer this before external communication.

**Q1 (Tree query observability)** and **Q5 (Performance benchmarks)** are lower priority for user communication but should be answered before Phase 6.

**Recommendation**: Scope these questions to a target phase for resolution. The spec is strong enough to proceed through Phase 5 (Echo migration) with them open, but they should be resolved before Phase 6 operator communications go out.

#### 2. Phase 5 Shadow Mode Needs a Pass/Fail Definition

Phase 5 describes "shadow mode validation" — logging what the tree would serve vs. what the monolith had for 24 hours. The spec does not define what constitutes a pass vs. fail in shadow mode. If the tree returns different content than the monolith in 15% of queries — is that acceptable? Concerning? Blocking?

From a user communication standpoint, the shadow mode period is a strong trust signal ("we ran the new system alongside the old one for 24 hours before switching"). That trust signal only works if there's a defined threshold and the operator knows the bar.

**Recommendation**: Define shadow mode success criteria (e.g., "semantic equivalence in > 90% of queries, no capability gaps in the critical 7 anti-pattern domains").

#### 3. "Behavioral Layer" Needs a User-Facing Name

The spec introduces "behavioral layer" as the session-start loading mechanism for Tier 3 content (~800 tokens). This is technically correct but opaque. If operators ask "what loads at session start?" the answer is "the seed, the capability index, and the behavioral layer" — which is meaningful to an engineer and confusing to everyone else.

This is a minor issue (it's unlikely operators will encounter the term "behavioral layer" unless they read this spec), but the session-start hook documentation and upgrade guide should use plain language: "At every session start, your agent also loads its core behavioral principles — the guidelines it uses to act, not just look things up."

---

### Evaluation of New Additions

#### Training Override Anchoring (Design Principle 6)

**Assessment**: This is the best addition in v2. It closes the gap between what Round 1 called "the awareness problem" — the risk that users interpret the migration as "agent now has to look things up." By making Training Override Anchoring an explicit design principle, the spec creates a durable architectural explanation: the agent has reflexes (seed) and a reference library (tree). Reflexes don't need lookup; that's what makes them reflexes.

The principle also provides a clear editorial rule for future authors: anything that must happen before the agent's first decision goes in the seed. This prevents the seed from drifting back toward a monolith and keeps the architecture self-documenting.

**For user communication**: This principle should be the centerpiece of the operator announcement. "Your agent's core behavior is hardwired from the first token. The things that make an Instar agent different from a generic LLM — knowing to build instead of escalate, to look up instead of guess, to admit errors instead of fabricate — are always loaded. They can't be queried away."

#### Resilience Mode Naming

**Assessment**: Fully adopted and well-executed. The failure mode table is the best example — every failure scenario is described in terms of what the agent can still do, not what it can't. "Agent uses seed lookup table to find answer manually" is a capability statement. "Degraded mode" was a failure statement. The reframe is complete and consistent throughout the spec.

The user-facing description in Principle 2 is particularly strong: "Resilience Mode — not a degraded state, but a designed fallback that preserves core functionality." This language can go directly into the upgrade announcement.

#### Updated Cost Model

**Assessment**: Significantly more honest and credible than v1. The acknowledgment that triage overhead must be measured with real numbers (not estimated) before Phase 4 is exactly right — it's the kind of epistemic humility that builds operator trust. The revised net savings figure (55-63%) with the explicit caveat "adjusted from 50% to account for triage overhead" is the right way to handle a corrected estimate.

One remaining issue: the spec still presents savings as token counts and percentages. The Round 1 recommendation to translate to operator outcomes — "your agent stays coherent longer in complex sessions" — is still not present in the spec. It doesn't need to be in the spec; it needs to be in the announcement. But since the announcement doesn't exist yet, this translation work remains outstanding.

---

### Updated Approval Status: APPROVE

The spec is ready to proceed. The remaining communication work (operator announcement, upgrade guide, user-facing narrative using the doctor analogy and Training Override Anchoring framing) should be completed before Phase 6 but does not need to block Phases 1-5. The architecture is sound, the naming is clean, the cost model is honest, and the behavioral safety story (critical 7 in seed) is now principled rather than just pragmatic.

The "CONDITIONAL" from Round 1 was contingent on resolving the anti-pattern loading question, correcting the cost model, and renaming "Degraded Mode." All three are resolved. The remaining issues (user-facing narrative, competitive positioning in announcements, shadow mode pass criteria) are delivery concerns, not design concerns.

The spec earns approval at the architecture level. The communication layer still needs one week of writing work before Phase 6.

---

### Updated Score: 9/10

**From 8 to 9 because:**

- Training Override Anchoring transforms the spec's marketing story from implicit to explicit — it gives both engineers and operators the right mental model
- "Resilience Mode" is consistently and correctly applied throughout
- The cost model now reflects honest accounting, including the critical caveat that real numbers must be measured before Phase 4
- Root cause of zero search count is documented and correctly framed
- All 5 Round 1 open questions are resolved with principled answers, not just pragmatic fixes
- 3 new open questions (from the synthesis consensus findings) have been turned into spec sections — triage granularity, tree query API, content integrity are all now designed, not deferred

**Not 10 because:**

- User-facing communication materials remain unwritten. The spec is now an excellent brief for an operator announcement, but the announcement itself doesn't exist. This is the correct state at spec-review time — but it means one deliverable is still outstanding before Phase 6.
- 5 remaining open questions, 2 of which (token budget enforcement, evolution system interaction) have user experience implications that should be resolved before broad rollout.
- Shadow mode lacks defined pass/fail criteria — a gap that matters when the shadow mode period becomes a trust signal in operator communications.
