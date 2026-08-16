# DX & API Design Review: Seed Migration Spec — Round 2

**Reviewer**: Claude Code (DX/API Design Specialist)
**Date**: 2026-03-14
**Spec**: `specs/seed-migration.md` — CLAUDE.md → Self-Knowledge Tree migration (v2, post-review)
**Round 1 Reference**: `specreview/output/20260314-104223/dx.md`

---

### Round 2 Assessment

The revision is substantial and directly addresses all three critical DX blockers from Round 1. The author did not paper over the issues — they went structural. The Tree Query API is now a concrete, well-formed spec. The anti-pattern timing problem is resolved architecturally with a permanent seed placement decision. The irrelevant result recovery path is explicitly defined with a four-step fallback ladder. These were the gaps that would have caused measurable first-5-minutes friction, and they are gone.

What elevates this revision beyond simple gap-filling: the design decisions section converts all five previously "open" questions into resolved answers with rationale. The spec no longer defers hard choices to implementation. The addition of Design Principle #6 (Training Override Anchoring) is particularly good — it makes the anti-pattern placement decision feel principled rather than ad hoc.

This is a materially better spec.

---

### Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| No recovery path for irrelevant tree search results | **RESOLVED** | Confidence scoring is defined with numeric thresholds (≥0.8 high, 0.5-0.79 medium, <0.5 low). The agent-facing protocol for low-confidence and empty results is specified: reformulate query → check capability index → fall back to Quick Lookup Table → query `/capabilities` directly. The resilience table adds the explicit case. |
| Tree Query API undefined | **RESOLVED** | `GET /self-knowledge/search?q=<query>&maxTokens=<budget>` is fully specified with response schema including `nodeId`, `content`, `confidence`, `source`, `cached`, `triageMethod`, `totalTokens`, and `query`. The confidence tier definitions are concrete and actionable. |
| Anti-pattern timing unresolved (Open Question #5) | **RESOLVED** | The top 7 critical anti-patterns are permanently in the seed (~40 lines, ~500 tokens). The remaining anti-patterns, gravity wells, and principles load via the Tier 3 behavioral layer at session start (~800 tokens). Crucially, Tier 3 is unconditional — not on-demand. Design Principle #6 anchors the reasoning. |

All three critical issues are fully resolved. Not partially addressed — resolved.

---

### New DX Assessment

#### Tree Query API Definition

The API spec is clean and sufficient for implementation. A few observations:

**Strengths:**
- Response includes `triageMethod` — this is excellent DX. When debugging a bad result, an agent can distinguish "rule-based matched wrong keyword" from "LLM chose poorly." Without this field, debugging is opaque.
- `cached: true` in the response is also good — it tells the agent whether a slow result was cold-cache or a tree performance problem.
- The confidence tier thresholds (0.8, 0.5) are concrete, not vague. An agent can make branching decisions on these.
- The four-step fallback ladder for low-confidence results is appropriately graduated — it doesn't skip to "give up" early.

**Remaining gap (minor):** The `maxTokens` parameter is mentioned in the query string but not defined in the response schema. The response shows `totalTokens` (how many were consumed), but there is no indication of what happens when the retrieved content would exceed `maxTokens`. Does the response truncate? Return a partial `content` field with a `truncated: true` flag? Return the node metadata but omit content? This maps to Remaining Open Question #3 in the spec, but from a DX standpoint an agent calling the endpoint needs to know what to expect when its budget is tight. The current schema leaves this as a runtime surprise.

**Recommendation:** Add to the response schema: `"truncated": false` (boolean) indicating whether content was cut to fit the token budget, and specify the truncation behavior (prefer complete sections over mid-paragraph cuts).

#### Confidence Scoring

The scoring model is well-designed. The 0.8 / 0.5 thresholds are defensible — 0.8 is a reasonable bar for "use this without skepticism" and 0.5 correctly triggers caution rather than silent acceptance.

One DX question worth noting: the score is a float from the triage system. In practice, rule-based triage produces binary or step-function confidence (matched keyword: 0.9, partial match: 0.6, no match: 0.0), while LLM triage produces more nuanced floats. Whether agents should treat these differently is not specified. For most use cases this doesn't matter — the thresholds handle it. But sophisticated agents doing debugging might want to know if a 0.75 came from a partial keyword match or from an LLM that was "moderately confident."

This is a P3 observation, not a blocker.

#### Capability Index

The capability index table format (capability name + query hint) is the right structure. Query hints are particularly useful — they teach agents the vocabulary the triage system expects, reducing semantic mismatch. "POST /feedback — report bugs and feature requests" is better than just "Feedback System" because it anchors the right terminology.

The truncated example shows "20 total capabilities" with an ellipsis. The actual implementation needs all 20+ populated before Phase 4. This is implementation detail, not a spec gap, but worth noting for completeness.

#### Resilience Mode Naming

The shift from "Degraded Mode" to "Resilience Mode" is the right call and the spec applies it consistently. The framing in Design Principle #2 is good: "Resilience Mode — not a degraded state, but a designed fallback that preserves core functionality." This is exactly the right user-facing narrative — it communicates intentional engineering rather than failure.

The resilience table is well-structured and correctly distinguishes "tree unavailable" from "content tampered" from "low confidence results" — three different conditions requiring different responses. Most specs would conflate at least two of these.

#### Triage Granularity Resolution

Phase 0 (two-stage triage: layer → node) is the correct fix for the B1 blocker identified in the synthesis. The spec resolves the problem I noted in Round 1 about all 35 capability nodes loading on any capability query. The two-stage approach — layer selection first, then node selection via rule-based keyword matching against the capability index — is elegant. It uses the capability index for double duty: agent awareness AND triage disambiguation.

The Phase 0 validation criteria are measurable and specific. "Query 'how do I publish something' returns only `capabilities.publishing`, not all 35 nodes" is a concrete test, not a vague requirement.

#### Content Integrity (HMAC)

The HMAC-per-file model with a central `context/.integrity.json` manifest is clean. Fail-closed on verification failure is the right default. The content framing with `<knowledge-fragment>` tags and HTML comment stripping addresses the injection surface from the synthesis.

One DX note: the spec says HMAC uses "the agent's auth token as key." Auth tokens rotate. The spec should specify what happens to the integrity manifest when the auth token changes — are all signatures invalidated and recomputed, or does the manifest store a key ID rather than using the live token directly? If an agent's auth token rotates during a session, every tree query would fail HMAC verification until the manifest is regenerated. This is an operational DX concern for long-running sessions.

**Recommendation:** Use a dedicated HMAC signing key (separate from the auth token) stored in `.instar/config.json`. The signing key doesn't rotate with session auth. This is how Playbook presumably handles it — the spec should confirm or clarify the mechanism.

---

### New Issues

#### N1. Token Budget Behavior on Truncation (Minor — P2)

The `maxTokens` query parameter is specified but the truncation behavior is undefined. An agent budgeting 500 tokens for a tree query needs to know whether it will get 500 tokens of content or a `truncated: true` flag or an error. Without this, agents cannot safely set token budgets — they either over-budget (defensive) or risk truncated content with no signal.

**Recommended fix:** Add to the response schema: `"truncated": boolean`, and define the truncation behavior (cut at section boundaries, not mid-paragraph). Low-effort addition to the API spec.

#### N2. HMAC Key / Auth Token Coupling (Minor — P2)

The spec specifies HMAC using "the agent's auth token as key" without addressing what happens on auth token rotation. If auth tokens rotate (e.g., after an update or re-initialization), the integrity manifest becomes invalid and all tree queries fail until recomputed. For agents with long sessions or automatic token rotation, this is a live operational concern.

**Recommended fix:** Use a dedicated, non-rotating signing key in config. One line of clarification in the Content Integrity section resolves this.

#### N3. Phase Ordering (Carried Forward — Recommendation)

The Phase 4 → Phase 5 → Phase 6 sequence still has the scaffold template shipping before the Echo pilot provides real-world learnings. Phase 5 (Echo migration) should inform Phase 4 (scaffold template), not follow it. The spec acknowledges this implicitly by calling Echo the "pilot" — but the sequence still has the scaffold locking in its design before the pilot validates it.

This was a recommendation in Round 1 and the Round 1 synthesis also flagged it. The v2 spec did not address it. It remains a recommendation, not a blocker — the risk is that the scaffold template needs updating post-pilot, which is extra work but not catastrophic.

**Recommended sequence:** Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 5 (Echo pilot) → Phase 4 (scaffold, informed by pilot) → Phase 6 → Phase 7.

---

### What Still Needs Attention (Remaining Open Questions)

The five remaining open questions in the spec are correctly scoped as deferred rather than blocking. From a DX lens:

- **Q1 (Operator observability of tree queries)** — A "last 10 tree queries" endpoint would help operators debug bad retrievals without needing agent session logs. Low priority but genuinely useful. Recommend `GET /self-knowledge/query-log`.
- **Q3 (Token budget enforcement)** — This is N1 above. Needs resolution before Phase 3 test suite.
- **Q4 (Evolution proposals modifying tree nodes)** — Worth specifying validation rules before Phase 2. A poisoned evolution proposal is a real attack vector.
- **Q2 and Q5** — Lower DX priority; sync mechanics are infrastructure concerns.

---

### Updated Approval Status: APPROVE

The three critical blockers from Round 1 are resolved. The new additions (Tree Query API, confidence scoring, capability index, Resilience Mode, two-stage triage, HMAC integrity) are all well-designed. The two new issues identified (truncation behavior, HMAC key coupling) are P2 — worth fixing before Phase 3, but not blockers for Phase 0-2.

The spec is ready to proceed. Phases 0-3 (additive, non-destructive) can begin immediately. The P2 issues should be resolved before Phase 3 test infrastructure ships.

---

### Updated Score: 9/10

**Justification:** The revision closed all three critical gaps and then went further — it resolved all five open questions, addressed the triage granularity blocker, added content integrity, defined the resilience mode with a correct naming shift, and made the behavioral layer loading unconditional rather than on-demand. The score is not 10/10 because the truncation behavior is genuinely unspecified (an agent cannot safely use `maxTokens` without knowing what truncation looks like), and the HMAC/auth-token coupling is a live operational risk in long sessions. Both are fixable in an afternoon. The architecture itself is sound, the tradeoffs are well-reasoned, and the test suite is comprehensive. This spec is ready for implementation.

---

### Summary

| Round 1 Issue | Round 2 Status |
|---------------|---------------|
| No irrelevant result recovery | RESOLVED — four-step fallback ladder + confidence tiers |
| Tree query API undefined | RESOLVED — full endpoint spec with response schema |
| Anti-pattern timing (Open Q5) | RESOLVED — top 7 in seed, Tier 3 behavioral layer unconditional |

| New Issue | Priority | Recommended Fix |
|-----------|----------|----------------|
| Truncation behavior undefined for `maxTokens` | P2 | Add `truncated: boolean` to response schema + define cut behavior |
| HMAC key coupled to auth token (rotation risk) | P2 | Use dedicated signing key in config, not live auth token |
| Phase ordering: scaffold before pilot | P3 (Recommendation) | Swap Phase 4 and Phase 5 in sequence |
