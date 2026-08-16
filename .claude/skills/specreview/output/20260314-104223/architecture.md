# Architecture Review: Seed Migration Spec (CLAUDE.md → Self-Knowledge Tree)

**Reviewer:** Echo (systems architect)
**Date:** 2026-03-14
**Spec:** `specs/seed-migration.md` — Draft v1

---

## Approval Status: CONDITIONAL

The core architecture is sound and the diagnosis is accurate. The spec earns conditional approval because the fundamental decisions are right (seed + tree, `file_section` over `memory_search`, graceful degradation), but several structural gaps need resolution before implementation begins — specifically around the triage architecture, anti-pattern loading, and the single-file vs multi-file question.

---

## Critical Issues

### 1. Triage Is Layer-Level, Not Node-Level — and the Spec Builds on a Gap

This is the most important architectural finding. Reading the actual `TreeTriage.ts` code reveals that triage scores **layers** (`identity`, `capabilities`, `experience`, `state`, `evolution`), not individual nodes. A query about "how do I publish something?" would score the `capabilities` layer as relevant, which then includes ALL capability nodes — feedback, jobs, sessions, publishing, tunnel, dashboard, etc. — all loaded together.

The spec proposes 35+ nodes under the `capabilities` layer. With layer-level triage, a query about CI health would pull in all 35 capability nodes simultaneously, likely flooding context. The architecture promises per-capability loading but the triage engine doesn't currently support per-node resolution within a layer.

**Before Phase 2 (Tree Node Configuration), you need to either:**
- (A) Extend `TreeTriage` to support node-level scoring within a layer (two-stage triage: layer → then nodes within that layer), OR
- (B) Create sub-layers (e.g., `capabilities.operational`, `capabilities.behavioral`, `capabilities.evolution`) so triage granularity matches the 35-node decomposition, OR
- (C) Accept that querying any capability topic will load all capability nodes, and set `maxTokens` per node tightly enough that this remains acceptable

Option A is the architecturally cleanest. Option C is the fastest to ship but the most wasteful — it partially defeats the purpose of the migration. This gap must be resolved before Phase 2.

### 2. Anti-Pattern Loading Has No Viable Trigger Mechanism

The spec describes Tier 3 content (anti-patterns, gravity wells, core principles) as "loaded when the agent is about to act." This is stated as a design property but no mechanism is specified for detecting this pre-action moment.

The tree's search mechanism is query-driven. Anti-pattern content would only surface if the agent explicitly queries for it — which an agent about to fall into a gravity well won't do. The "Settling" trap, "Defensive Fabrication" trap, and "Escalate to Human" trap are all failure modes that feel correct to the agent in the moment. Agents don't query "am I about to settle for failure?" before settling for failure.

This isn't a flaw in the spec's diagnosis — it accurately identifies that anti-patterns are most needed at decision points. The flaw is that no mechanism bridges "agent is about to act" with "tree loads anti-pattern content." Options:

- **Session-start always-include** for the top 3-5 most critical anti-patterns (Settling, Defensive Fabrication, File-and-Wait for Echo specifically). This contradicts the "load on-demand" goal but the weight is small (~300 tokens) for high-value content.
- **Post-action hook injection** via the session-start hook that proactively injects anti-patterns at known action boundaries (pre-deploy, pre-message, pre-git). This requires hook instrumentation that doesn't exist.
- **Compaction-recovery always-inject** — after compaction, anti-patterns are always included in recovery context. This is the correct recovery point since compaction is when behavioral drift is most likely.

The spec's Open Question #5 acknowledges this. It should be resolved as a hard architectural decision before Phase 3, not deferred.

---

## Recommendations

### R1: Resolve the Single-File vs Multi-File Question Now

The spec poses this as an open question but it's load-bearing. The architecture depends on the answer.

**Recommendation: Single file (`capabilities-reference.md`) with a strict heading schema.**

Reasoning:
- `file_section` extraction in `TreeTraversal.ts` operates on heading match. A single file with consistent heading names (`## Publishing`, `## Jobs`, `## Dashboard`) is simpler and more reliable than 35 separate files that must be individually tracked, versioned, and referenced in `self-knowledge-tree.json`.
- A single file can be opened, searched, and edited as one document — critical for the migration author who needs to verify 100% coverage.
- The "harder to maintain independently" concern for multi-file is real: a rename of a file path breaks every tree node that references it. With a single file, only the heading needs to match.
- **Counter-concern**: If `capabilities-reference.md` grows to 650+ lines, file_section extraction must be robust. Verify that `TreeTraversal.ts`'s section extraction handles duplicate headings, nested headings, and headings with trailing punctuation correctly before committing to this format.

### R2: Add a Capability Index to the Seed

Open Question #1 (seed includes a capability summary) should resolve to **yes**.

A one-line-per-capability index (~25 lines, ~500 tokens) in the seed serves a different function than the full documentation in the tree. The index answers "does this capability exist?" The tree answers "how do I use it?" Without the index, an agent would need to query the tree to discover whether a capability exists before querying the tree for how to use it — two round trips. With the index, the first-round-trip is eliminated for the majority of cases.

The "grows with each new capability" concern is manageable: each new capability adds one line. At the current trajectory, the index would hit 50 capabilities in roughly 2 years — still only ~50 tokens of growth.

Format recommendation: A table with `Capability | One-line description | Tree query` so the agent knows both what exists and what to search for.

### R3: Preserve Echo-Specific Anti-Patterns in the Seed

Open Question #2 (agent-specific content) should resolve to: **agent-specific behavioral overrides that prevent anti-patterns go in the seed, not the tree.**

For Echo specifically: "I am the instar developer — never use POST /feedback for instar issues, never file GitHub issues, never escalate to Justin for instar bugs" must be in the seed. The reasoning is the same as for general anti-patterns: an agent about to violate this rule won't query the tree for the rule. These lines are small (~5 lines) and the protection they provide is high.

The general rule: if the behavioral override is safety-critical and violation is likely without it, it belongs in the seed. If it's operational detail, it belongs in the tree.

### R4: Session-Start Proactive Load Should Be Optional, Not Default

Open Question #3 (query tree at session start) should resolve to **optional, not default for all agents**.

The spec proposes proactively loading the capabilities layer at startup for ~2,000 tokens of "immediate awareness." This defeats the migration's primary goal (session token reduction from 17,600 to ~4,000+~2,000 on-demand). If you always load capabilities at startup, you've traded a 17,600-token static load for a 6,000-token static load — a 66% reduction, not the 77%+ the spec targets.

Better approach: the session-start hook outputs the capability index (R2 above, ~500 tokens) rather than proactively loading the full capabilities layer. Agents who need a specific capability can query on demand. Agents who don't need any capability in a given session pay only 500 tokens instead of 2,000+.

For agents with known high-capability usage patterns (e.g., a dedicated CI monitoring agent that always queries jobs and CI health), a config flag could enable proactive loading at scaffold time.

### R5: Spec Phase Ordering Has One Inversion

The spec's Implementation Sequence lists:
```
Phase 3: End-to-end test suite ← Must pass before Phase 4
Phase 4: Scaffold Template Update
Phase 5: Echo Migration (pilot)
```

But Phase 4 (Scaffold Template Update) changes how new agents are built — not how existing agents behave. Running Echo's migration (Phase 5) before or alongside Phase 4 is correct. However, the test suite (Phase 3) requires a functioning seed + tree setup to test against, which means the test suite depends on Phase 2 completion. The sequence should clarify that Phase 3 tests are built in parallel with Phase 2 execution, not after it completes.

More critically: the spec should add a Phase 0 — resolve the triage granularity gap (Critical Issue #1) before any tree node configuration begins.

---

## Observations

### The `file_section` Decision Is Correct and Well-Reasoned

The spec's rejection of `memory_search` for operational docs is exactly right. Memory search is fuzzy retrieval over accumulated notes — it returns fragments, not authoritative docs, and its recall degrades when MEMORY.md is sparse or freshly initialized. For feature documentation that must be complete and reliable, `file_section` with heading match is the correct source type. This mirrors the RAG architectural principle that structured, deterministic retrieval should be preferred over semantic search for high-stakes, authoritative content.

The combination — `file_section` for operational docs, `memory_search` for experience nodes (lessons, decisions) — is the appropriate tool-for-purpose assignment.

### The Current Tree Has a Population Problem

Looking at the actual `self-knowledge-tree.json`: the tree has 13 nodes across 5 layers, but zero searches have ever been run against it. The spec correctly identifies this as an adoption failure caused by CLAUDE.md never being slimmed down to trust the tree. This is a systemic problem worth naming explicitly: a retrieval system that nothing queries is invisible infrastructure. The migration's value isn't just token savings — it forces actual adoption by removing the monolith that makes the tree unnecessary.

### Degraded Mode Architecture Is Solid

The fallback table is well-designed. The most important fallback — server down → agent reads files manually — is the right one to design first because it's the most severe and most likely to happen (server restart, crash during heavy load). The seed's Quick Lookup Table as "the fallback compass" is the correct mental model.

One gap: the spec doesn't address what happens when `capabilities-reference.md` exists but is stale (e.g., written for a v0.18 agent running v0.20 server). Stale documentation is worse than no documentation because the agent will confidently use the wrong endpoint. Recommendation: add a schema version header to `capabilities-reference.md` and have the tree validate it against the server version during health checks.

### The Test Suite Is the Spec's Strongest Section

The six test categories, A/B comparison framework, and LLM-graded evaluation are well-conceived. Notably, the test for "All 20 capabilities" (one query per capability from Tier 2) is the minimum viable regression gate — this is the test that must pass before any production rollout. The test infrastructure design (dedicated test agent, LLM grader, token counting via API metadata) is architecturally sound.

One addition: add a test that measures **false positive rate** for the triage layer. That is: for a query that is clearly NOT about capability X, verify that the triage does not load capability X's node. Without this, you can't distinguish between a system that correctly loads relevant nodes and one that loads everything every time.

### Compaction Recovery Works with the New Model

The spec's hook update plan (Phase 7) correctly maintains the compaction recovery contract. The compaction-recovery hook injects seed + AGENT.md + MEMORY.md. Since the seed is smaller under the new model, compaction recovery is actually cheaper. The tree is NOT injected during compaction recovery — agents recovering from compaction query the tree on-demand as they need capabilities. This is correct behavior.

---

## Research Findings

Independent research on RAG architecture patterns and LLM agent context management supports the spec's core decisions:

**Hierarchical retrieval is the right pattern for this use case.** Research (Gao et al., "Retrieval-Augmented Generation for Large Language Models: A Survey") documents that advanced RAG systems move from flat document retrieval toward structured, hierarchical retrieval where coarse-grained routing (layer selection) precedes fine-grained content extraction (node traversal). The spec's layer → node → source hierarchy mirrors this pattern.

**Deterministic retrieval for structured knowledge, semantic retrieval for experience.** The principle that structured, authoritative documentation should use deterministic retrieval (heading-based `file_section`) while accumulated, contextual knowledge should use semantic retrieval (memory search) is well-established. The spec's assignment of source types by content category is aligned with best practice.

**Context window budgeting should be explicit.** Agent research (Lilian Weng, "LLM Powered Autonomous Agents") establishes that "restricted context capacity limits the inclusion of historical information, detailed instructions, API call context, and responses" — and that multi-dimensional retrieval (recency + importance + relevance) helps. The spec's `maxTokens` per node is the right mechanism, but the current tree config shows nodes with 200-600 token budgets. The 35 capability nodes will need tighter budgets (100-200 tokens each) to avoid aggregate context bloat when multiple nodes are loaded.

**The system prompt monolith anti-pattern is well-documented.** Anthropic's agent engineering guidance emphasizes "simple, composable patterns" and warns against monolithic system prompts that attempt to encode all context statically. The migration is architecturally aligned with this guidance — the seed functions as a minimal system prompt, with the tree providing composable, on-demand augmentation.

**Single-doc vs multi-doc retrieval:** For structured reference documentation (API docs, feature guides), single-document retrieval with section extraction is preferred over multi-document retrieval. Multi-document retrieval introduces ranking problems (which doc wins if two sections address the same query?) and coverage gaps (what if no doc matches?). The spec's single-file approach avoids both problems.

---

## Scalability Assessment

**Good:**
- The seed size is bounded by design. New features go to the tree, not CLAUDE.md. Growth trajectory changes from linear to flat for session costs.
- The tree is extensible — `addNode()` exists, the JSON schema is versioned, and the validation endpoint provides health signals.
- The test suite scales: adding a new capability requires one tree node and one test case. The framework handles both.

**Concern:**
- The `capabilities-reference.md` file will grow with every new feature. At 35+ capabilities today, 650 lines, it will be 1000+ lines in 12 months. File_section extraction performance and correctness at this scale should be tested explicitly. More importantly, a developer modifying `capabilities-reference.md` needs to know which tree node references which heading — without tooling support (e.g., a linter that verifies heading ↔ node ID alignment), the file will accumulate broken references silently.
- The triage layer-level granularity gap (Critical Issue #1) is a scalability ceiling. At 35+ nodes in the capabilities layer, layer-level triage means capabilities queries always load all capability nodes. This problem compounds as the node count grows.

**Strong:**
- The rollback architecture is production-grade. Backup-before-migrate, per-phase gates, and the ability to restore from any snapshot provide confidence for the pilot phase.
- The upgrade path for existing agents (Phase 6) correctly targets 3+ agents as the validation threshold before broad rollout.

---

## Score: 7/10

**Justification:** The diagnosis is accurate, the high-level architecture is correct, the source type decisions are well-reasoned, and the test suite design is strong. The score is held back by: (1) a critical triage granularity gap that the spec doesn't acknowledge and that undermines the per-capability loading promise, (2) unresolved anti-pattern loading mechanism, and (3) three open questions that are actually load-bearing architectural decisions deferred as open questions. Resolving Critical Issues #1 and #2 and locking down the three recommendation items would bring this to a 9/10 before implementation begins.

The architecture is approvable if Phase 0 (triage granularity resolution) is completed before Phase 2 begins.
