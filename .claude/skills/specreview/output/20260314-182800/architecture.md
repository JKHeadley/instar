# Architecture Review: Seed Migration Spec — Round 2

**Reviewer:** Echo (systems architect)
**Date:** 2026-03-14
**Spec:** `specs/seed-migration.md` — Draft v2 (post-review)
**Round 1 Review:** `20260314-104223/architecture.md`

---

## Round 2 Assessment

This is a substantially improved specification. Both critical issues from Round 1 have been addressed. The five P0 blockers from the synthesis have all received treatment. The revised spec reads like an architecture that has been stress-tested — the open questions are resolved, the decisions are justified, and the implementation sequence has been hardened with a Phase 0 prerequisite gate.

The most significant improvement is that the spec now acknowledges the triage granularity problem explicitly, mandates the two-stage fix before Phase 2 begins, and adds Phase 0 as a formal prerequisite. The anti-pattern problem has been resolved with the correct hybrid strategy — the 7 critical overrides in the seed, the remainder loaded unconditionally at session start. Neither is deferred to on-demand, which is the architecturally correct answer.

---

## Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| **Critical Issue #1: Triage Is Layer-Level, Not Node-Level** | RESOLVED | v2 explicitly mandates two-stage triage (layer → node), adds Phase 0 as prerequisite, specifies rule-based keyword matching for Stage 2, and includes validation criteria for the fix ("query 'how do I publish' returns only `capabilities.publishing`, not all 35 nodes"). The spec now formally calls this out as a blocker rather than leaving it implicit. |
| **Critical Issue #2: Anti-Pattern Loading Has No Viable Trigger Mechanism** | RESOLVED | The hybrid strategy is now the spec's position: top 7 anti-patterns in seed (always loaded), remaining anti-patterns in Tier 3 behavioral layer loaded unconditionally at session start via session-start hook (~800 tokens). The critical design insight is now written as Design Principle #6 ("Training Override Anchoring") — these patterns are "the precondition for everything else working." The spec correctly rejects any on-demand approach for anti-patterns. |
| **R1: Single-File vs Multi-File** | RESOLVED | Spec adopts the many-files approach with individual files per capability domain (`context/capabilities/{node-id}.md`). The reasoning section names six distinct advantages (blast radius, independent versioning, cache coherence, least-privilege access, simpler HMAC, auditability). The spec flipped from my Round 1 recommendation to the synthesis majority position — and the arguments for many-files are stronger. |
| **R2: Capability Index in Seed** | RESOLVED | Included as a 25-line Tier 1 section with a `Capability | Query Hint` table format. Estimated cost: ~500 tokens. |
| **R3: Echo-Specific Anti-Patterns in Seed** | RESOLVED | Agent-specific overrides are now a named Tier 1 content block with the "identity test" formalized: "Would violating this rule cause the agent to act against its fundamental role?" Echo's "never POST /feedback" is cited explicitly as a passing example. |
| **R4: Session-Start Proactive Load** | RESOLVED | Spec adopts the middle-ground position from the synthesis: capability index (~500 tokens) at session start for awareness, not full content. The Tier 3 behavioral layer (~800 tokens) also loads at session start unconditionally. Together these total ~1,300 tokens vs. the 2,000+ tokens that full capability layer loading would cost. |
| **R5: Phase Ordering Inversion** | RESOLVED | Phase 0 is now a formal prerequisite phase, explicitly required before Phase 2. The implementation sequence makes this unambiguous. |

---

## New Architecture Decisions Assessment

### Many-Files Strategy

**Decision:** Individual files per capability domain (`context/capabilities/{node-id}.md`) rather than a single `capabilities-reference.md`.

**Assessment: Correct.**

The spec's six-point justification is sound. The strongest arguments are blast radius reduction and HMAC simplicity. With a single file, HMAC verification must operate at the section level — you either sign the whole file (coarse granularity, one corrupted section invalidates all content) or sign each section independently (complex, requires section-boundary detection). With individual files, the HMAC is straightforward: one file, one signature, one verify call. The cache coherence argument is also strong — a TTL-based cache with file-path keys works cleanly per-file. Section-based cache invalidation within a monolith is significantly more complex.

**One gap:** The spec doesn't address the developer maintenance burden of 35+ individual files. Specifically: when instar ships a new version that changes an endpoint, the developer must find and update the correct capability file. With a monolith, grep finds all references. With 35 files, the update surface is larger but the failure mode is contained. This is the right tradeoff, but the spec should add a note that the context file directory is the single source of truth and developers should not also update CLAUDE.md as a shortcut.

**Potential issue:** The spec lists `capabilities.secrets` with `context/capabilities/secrets.md` in the Tier 2 table but "Secret Drop" is not in the capability index sample shown in the Tier 1 section. The Tier 1 capability index sample only shows 6 of the 20 capabilities and trails off with `...`. Whether Secret Drop will appear in the full index is not confirmed. Minor, but the capability index must include ALL Tier 2 nodes by definition — otherwise agents can't formulate queries for capabilities they don't know about.

### Two-Stage Triage

**Decision:** Stage 1 selects layers; Stage 2 uses rule-based keyword matching within the selected layer to select individual nodes.

**Assessment: Correct, with one implementation risk.**

The two-stage approach is the right architecture. Stage 1 (layer selection) maps to the existing TreeTriage behavior. Stage 2 (node selection) is new. The spec specifies rule-based keyword matching for Stage 2 — this is the correct default because it's zero-cost and deterministic.

**Implementation risk:** The spec says Stage 2 uses "rule-based matching against the capability index keywords." This means the capability index in the seed serves double duty: it's both a human-readable awareness list and the source of keyword rules for Stage 2 node selection. This coupling is elegant but fragile. If the capability index keywords diverge from what Stage 2's rule engine expects (e.g., someone updates the index text but not the rule engine), queries will misroute. The implementation should ensure Stage 2's keyword rules are generated from or validated against the capability index at tree build time, not maintained separately.

**Not addressed:** What happens when Stage 2 returns multiple nodes? For example, a query about "how do I publish and then schedule a job?" correctly matches `capabilities.publishing` AND `capabilities.jobs`. The spec's API response format supports returning multiple results (the `results` array), but Stage 2 node selection for multi-capability queries isn't explicitly defined. The spec should specify a max number of nodes returned per query (I'd suggest 3) and clarify how multi-match is handled.

### HMAC Integrity

**Decision:** HMAC-SHA256 using auth token as key, signatures stored in `context/.integrity.json`, verified at every tree traversal, fail-closed on verification failure.

**Assessment: Substantially correct. Two refinements needed.**

The Playbook precedent makes this lower-risk than it would otherwise be — the mechanism is already understood and deployed. The fail-closed behavior (serve nothing if verification fails) is the correct security posture. The "log a security event" path ensures the failure is visible.

**Refinement 1:** Using the auth token as the HMAC key creates a key rotation problem. If the auth token changes (e.g., the user regenerates their agent's token), all existing HMAC signatures become invalid. The agent would fail to serve ANY content until every context file is re-signed. The spec doesn't address key rotation. This should be resolved before Phase 1 — either (a) use a separate, stable signing key, (b) document the re-sign procedure explicitly and add it to the key rotation playbook, or (c) store the key hash alongside the signature so mismatches are detected early with a clear error.

**Refinement 2:** The spec says signatures are stored in `context/.integrity.json` and git sync includes this manifest. This is correct for preventing local tampering, but if the git repo itself is compromised (a compromised git pull), the attacker can update both the context file AND the integrity manifest atomically. The HMAC provides no protection against a compromised repository. This is an accepted limitation (the same limitation applies to Playbook), but it should be explicitly stated — the integrity mechanism protects against local file system corruption and non-git tampering, not against a compromised git origin.

### Content Framing

**Decision:** Retrieved content wrapped in `<knowledge-fragment source="..." verified="true">` tags. HTML comments stripped before serving.

**Assessment: Good. One gap.**

The `verified="true"` attribute in the knowledge-fragment tag is meaningfully useful — it signals to the agent that this content passed HMAC verification, not just that it was retrieved. The HTML comment stripping addresses the obvious injection vector.

**Gap:** The spec strips HTML comments but doesn't address Markdown injection variants — specifically, retrieval content that contains `---` (YAML front matter delimiters) which could confuse parsers, or content that starts with lines that look like system prompts when fragment tags are stripped. The content framing approach is sound, but the spec should note that context files should use a restricted Markdown subset (no raw HTML, no YAML front matter) and the tree traversal should enforce this constraint before serving.

### Cache Strategy

**Decision:** Content-addressed cache (file path + modification time). TTL: 1 hour (rule-based), 30 minutes (LLM). File-change events for immediate invalidation. Per-agent scope. HMAC included in cache entries.

**Assessment: Well-designed.**

Including the HMAC in cache entries so that file changes invalidate cached content is architecturally clean — it means a tampered file is detected not just at serve time but also at cache read time (the HMAC changes, the cache entry is stale). The per-agent scope is correct for the current scale; shared caches can be evaluated at Phase 3.

**One clarification needed:** The spec says "file-change events trigger immediate cache invalidation for affected nodes." This implies a file-watching mechanism (e.g., `fs.watch` or `chokidar`). This is fine in development but can be resource-intensive for 35+ files on a machine with multiple agents. The spec should clarify whether file-watching is used or whether cache invalidation on write (the write operation explicitly invalidates the cache entry) is the mechanism. Write-time invalidation is simpler and avoids the file-watching resource cost.

---

## New Issues (if any)

### New Issue 1: Tier 3 Session-Start Loading Adds ~800 Tokens Unconditionally — Budget Math Needs Update

The revised cost model in the spec shows:
```
Per-session triage overhead: ~1,500-3,000 tokens (est. 3 queries × 500-1,000 tokens each)
Estimated net per-session cost: ~6,500-8,000 tokens
```

This estimate does not include the session-start behavioral layer (Tier 3, ~800 tokens). The actual net per-session cost is:

```
~5,000 (seed) + ~800 (Tier 3 behavioral layer, unconditional) + ~1,500-3,000 (triage overhead)
= ~7,300-8,800 tokens per session
```

The success criteria say "net token savings > 40%" compared to the 17,600-token monolith. At 8,800 tokens, savings are 50% — still passing. But the cost model in the spec should be updated to include the Tier 3 unconditional load so the numbers are accurate. Leaving it out understates the actual baseline.

### New Issue 2: Phase 0 Is Underspecified for Implementation

Phase 0 is now a prerequisite, but the spec's deliverable description is thin: "Updated `TreeTriage.ts` with two-stage scoring. Rule-based node selection using capability index keywords."

The validation criteria are better (three specific test cases), but Phase 0 is implementing a new algorithm in a system that currently has zero test coverage (zero searches ever run). The spec should either:
- (A) Add a specific test harness for Phase 0 that validates Stage 2 node selection before Phase 1 begins, or
- (B) Include Phase 0 validation in Category 6 (Performance) of the test suite with an explicit gate: "Phase 1 does not begin until Phase 0 validation passes"

Currently, the phase sequence shows Phase 3 (test suite) coming after Phase 2. But Phase 0 validation logically belongs before Phase 1. The test suite structure should reflect this.

### New Issue 3: Stale Content Version Mismatch Not Addressed

My Round 1 review raised this: what happens when `capabilities-reference.md` exists but is stale (written for an older server version)? The v2 spec doesn't address this for the many-files strategy either. If a context file documents the v0.18 API signature for `/jobs` and the server is now running v0.20 with a different response format, the agent will get confidently wrong documentation.

The spec should add: a schema version header in each context file (e.g., `<!-- instar-version: 0.19.0 -->`) and a tree health check that validates content file versions against the running server version. This was in my Round 1 recommendations and remains unaddressed.

### New Issue 4: Upgrade Script Schema Validation Is Mentioned But Not Defined

Phase 6 says the upgrade script will "validate upgrade script output against a schema (prevents supply chain attacks via malicious CLAUDE.md content)." This is a good addition, but the schema itself is undefined. What constitutes a valid seed CLAUDE.md? Without a defined schema, this validation step is aspirational. The spec should either define the schema (even at a high level: required sections, line count bounds, prohibited patterns) or explicitly mark this as a post-Phase-5 design task.

### New Issue 5: Remaining Open Questions Carry Operational Risk

The 5 remaining open questions (tree query observability, multi-machine sync, token budget enforcement, evolution proposals, performance benchmarks) are correctly deferred — they're genuinely lower priority. However, open question #3 (token budget enforcement) has an operational impact that could surface during Phase 5:

If a context file for a verbose capability (e.g., the full Telegram API docs) exceeds its `maxTokens` budget, what does the agent see? A truncated response that looks complete is worse than an explicit partial indicator. The spec should resolve this before Phase 5 begins — Phase 5 is where real agents use the real tree for the first time, and the first truncation event will be confusing without a defined behavior. My recommendation: the tree response should include a `truncated: true` flag when the content is cut, so the agent knows to ask for clarification or use a more specific query.

---

## Updated Approval Status: APPROVE

The two critical blockers from Round 1 are resolved. The five P0 blockers from the synthesis are treated. The spec now has:

- A formal Phase 0 prerequisite for triage granularity
- An explicit, justified anti-pattern strategy (seed + unconditional session-start)
- A defined Tree Query API with confidence scoring and recovery path
- HMAC integrity architecture
- Content framing with injection resistance
- A cache strategy with invalidation logic
- Tree isolation between agents
- Resolved design decisions replacing all open questions
- A staggered rollout with validation gates

The five new issues I've identified are all refinements, not blockers. Issues 1 and 2 should be addressed before implementation begins (budget math correction, Phase 0 test gate). Issues 3-5 can be addressed during their respective phases.

---

## Updated Score: 9/10

**Justification:** The diagnostic accuracy, high-level architecture, and source type decisions were already strong in Round 1. This round shows the spec is implementation-ready. The triage granularity gap — which was the most dangerous architectural flaw — is now a named Phase 0 prerequisite with concrete validation criteria. The anti-pattern loading question — which was the most dangerous behavioral risk — is resolved with the correct hybrid strategy and elevated to a Design Principle.

The remaining point deduction reflects: (1) the HMAC key rotation problem (using the auth token as HMAC key creates a fragile dependency on a mutable credential), (2) the budget math that understates actual session cost by omitting the ~800-token unconditional Tier 3 load, and (3) the stale content version mismatch issue that has persisted across both rounds without resolution. These are refinements, not blockers, but they represent genuine gaps in a spec that is otherwise close to implementation-grade.

This architecture is approved for implementation, subject to addressing Issues 1 and 2 before Phase 1 begins.
