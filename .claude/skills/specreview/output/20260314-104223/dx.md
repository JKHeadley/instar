# DX & API Design Review: Seed Migration Spec

**Reviewer**: Claude Code (DX/API Design Specialist)
**Date**: 2026-03-14
**Spec**: `specs/seed-migration.md` — CLAUDE.md → Self-Knowledge Tree migration

---

### Approval Status: CONDITIONAL

The spec is architecturally sound and the token savings case is compelling. However, there are significant DX gaps that will cause agent friction in practice — specifically around irrelevant search recovery, the tree query API surface, and anti-pattern loading timing. These are solvable but need to be addressed before Phase 4 (scaffold template) ships.

---

## Critical Issues

### 1. No Defined Recovery Path for Irrelevant Tree Search Results

This is the most serious DX gap. The spec defines what happens when the tree is *down* (graceful degradation table), but never addresses what happens when the tree *responds with wrong content* — which is a much more common failure mode.

When an agent queries the tree for "how do I publish publicly" and gets back the `capabilities.git_sync` node (a plausible mismatch given semantic overlap between "publish" and "push"), what happens?

- Does the agent know the result was wrong?
- Is there a confidence score it can inspect?
- Can it retry with a different query?
- Is there a "none of these match" escape hatch?

The spec mentions "LLM-powered triage" and "score_threshold" concepts implicitly (via tree node search), but the agent-facing contract for handling low-confidence or mismatched results is completely absent. In CrewAI and other frameworks, `score_threshold` is an explicit tunable that determines whether results are surfaced at all — and agents receive explicit empty-result signals that they can act on. This spec has neither.

**What's missing**: A defined behavior when tree search returns results that don't match the agent's intent. Options:
- Confidence scoring surfaced to the agent in search responses
- Explicit "no match" vs. "low confidence match" vs. "high confidence match" signal
- Retry-with-clarification protocol the agent can follow
- Node introspection so the agent can verify it got the right node before using it

### 2. Anti-Pattern Loading Arrives Too Late (Open Question #5 Unresolved)

The spec correctly identifies this tension: anti-patterns are most valuable when the agent is *about to violate them* — but by then, loading them is reactive rather than preventive.

This isn't just a timing problem — it's a context-window economics problem. When the agent is in the middle of a decision ("should I use `gh issue` or the feedback API?"), it will likely *not* pause to query the tree for anti-patterns. The query costs tokens and latency at exactly the moment the agent is under task pressure.

The spec defers this to Open Question #5 without proposing a resolution. But the answer matters architecturally: if critical anti-patterns don't load until after the trap is already triggered, the behavioral tests in Category 3 will have worse pass rates than the current monolith.

The research from Anthropic's building-effective-agents guide is relevant here: "ground truth from the environment at each step" is how agents assess their progress. Anti-patterns are pre-action constraints, not post-action evaluations — they need to be in-context *before* the relevant decision, not summoned after.

**Recommendation**: The top 5-7 highest-consequence anti-patterns (File-and-Wait, Escalate to Human, Answer From Memory, GitHub Issues, Defensive Fabrication) should stay in the seed. The remaining ~7 lower-frequency anti-patterns can go to the tree. This is a 50-80 line addition to the seed — well within the <250 line budget.

### 3. Tree Query API is Undefined

The spec describes what the tree *contains* and what it *serves*, but never defines the query API an agent actually calls. The entire "how to query the tree for everything else" lives as a bullet point in the Tier 1 seed table ("Self-Knowledge Tree pointer, ~15 lines") without any concrete specification.

From a DX perspective, this is the most critical missing piece. The first 5 minutes of a new agent's session depend on this. What does the seed say about querying the tree? What's the actual command or endpoint? What does the response look like?

The only concrete API reference in the spec is validation-side (`GET /self-knowledge/validate`, `GET /self-knowledge/health`). There's no `GET /self-knowledge/query?q=...` or equivalent documented anywhere.

**What an agent needs to see in the seed's tree pointer section**:
```
To look up any capability: GET /self-knowledge/query?q=<your question>
Response includes: node id, content, confidence, and related nodes
If confidence < 0.7: try a more specific query or check /self-knowledge/nodes for the full index
```

Without this, the "Self-Knowledge Tree pointer" section in the seed is a promise without a delivery mechanism.

---

## Significant Recommendations

### 4. Open Question #1 (Capability Summary in Seed) Should Be Resolved: Yes, Include It

The spec asks whether to include a one-line-per-capability summary (~20 lines) in the seed. The answer from DX principles is yes, for the following reason:

**Discoverable systems outperform opaque ones.** If an agent doesn't know that `capabilities.stall_triage` exists, it will never query for it — even if the tree could serve it perfectly. A capability an agent doesn't know to search for is a capability that doesn't exist from that agent's perspective.

The LangSmith evaluation research underscores this: offline evaluation requires "manually curated examples of what constitutes good retrievals." An agent that doesn't know stall triage exists can't even formulate the right query. The capability summary in the seed is the mechanism that makes the tree queryable in the first place — it converts the tree from a lookup service into a discoverable index.

20 lines is cheap insurance. The concern about "it grows with each new capability" is real but manageable: the summary is one line per capability, not docs. It will grow at 1 line per feature, not 50.

### 5. No Agent Introspection Endpoint for the Tree

The spec validates tree coverage during migration (`/self-knowledge/validate`, `/self-knowledge/health`), but these appear to be maintenance endpoints, not agent-facing ones. There's no specified way for a *running agent* to ask: "What nodes does this tree have?" or "What content is currently loaded in node X?"

This matters for debugging. When an agent gets an unexpected answer from the tree, it needs to be able to inspect the tree's state — what it thinks it knows. Without this, debugging a bad tree response is opaque from the agent's side.

**Recommendation**: Document `GET /self-knowledge/nodes` (index of all node IDs and descriptions) and `GET /self-knowledge/nodes/{id}` (content of a specific node) as agent-facing endpoints in the seed's tree pointer section.

### 6. Open Question #4 (Single File vs. Many Files) Should Be Resolved: Many Files

The spec asks whether to use one `capabilities-reference.md` or many per-capability files. From a DX standpoint, many files is superior for the following reasons:

- **Auditability**: When a capability changes, the diff is scoped to one file. With one big file, every capability change touches the same file — harder to review.
- **Tree node isolation**: If `context/publishing.md` goes missing, only the publishing node degrades. If `capabilities-reference.md` goes missing, all 20+ nodes degrade simultaneously.
- **Cache coherence**: The tree can cache individual files. One big file means the cache entry for the entire reference is invalidated whenever any capability changes.
- **Parallel development**: Multiple capabilities can be updated without merge conflicts.

The spec's concern ("single file is simpler for tree traversal") is addressable with a consistent naming convention: `context/capabilities/{node-id}.md`. Tree traversal uses the node ID to construct the path deterministically — no lookup table needed.

### 7. Upgrade Path DX Needs More Detail

Phase 4 (Upgrade Path) is underspecified. The spec says the script will "back up CLAUDE.md, extract content, replace with seed, regenerate tree, validate" — but says nothing about what happens during the transition window.

The time between "CLAUDE.md replaced" and "tree fully validated" is a dangerous gap. If the tree config fails validation after CLAUDE.md is already replaced, what's the agent's state? The spec says "validate the migration" but doesn't specify what "validate" means in terms of agent-observable behavior during this window.

**Specific gap**: The upgrade script should produce a "migration status" signal that the session-start hook can inspect. If migration is in-progress or failed, the hook should fall back to the backed-up monolith CLAUDE.md, not the partially-migrated seed.

---

## Observations

### Strong: The `file_section` vs. `memory_search` Decision

The spec's analysis of why `memory_search` is wrong for operational docs is correct and well-argued. Using `file_section` with a dedicated reference file gives reliable, authoritative retrieval — exactly what LlamaIndex and CrewAI's best practices recommend for structured knowledge (as opposed to experiential/learned knowledge). This is the right call.

### Strong: Degraded Mode Table

The degraded mode behavior table is thorough and covers the right failure modes. The distinction between "tree unavailable" and "context file missing" is particularly good — these require different agent responses, and the spec handles them differently. Most RAG system specs conflate these.

### Strong: A/B Comparison Framework

Testing seed vs. monolith on the same prompts with LLM grading is the right evaluation methodology. This directly addresses the risk that token savings come at the cost of capability degradation. The specific pass criteria for each test (mention Telegraph, include endpoint, warn about public access) are measurable — not vague.

### Weak: Phase 3 Test Suite Ordering

The spec's implementation sequence shows Phase 3 (test suite) running *before* Phase 4 (scaffold template). But Phase 5 (Echo migration, the first real-world test) comes *after* Phase 4. This means the scaffold template ships before the test suite has been validated against a real migration.

The sequence should be: Phase 1 → Phase 2 → Phase 3 → Phase 5 (Echo pilot, as the first real validation of the test suite) → Phase 4 (scaffold update, informed by Echo pilot results) → Phase 6.

Echo should be the template that informs the scaffold, not the other way around.

### Weak: No Session-Start Warm-Up Strategy

The spec mentions "proactively loading the capabilities layer at startup" as Open Question #3 (~2,000 tokens) but doesn't resolve it. This decision significantly affects the first-5-minutes DX:

- **Without warm-up**: Agent starts fast, but first capability query has cold-cache latency. If the agent's first task is capability-dependent (e.g., "check my jobs"), it hits an 8-second delay immediately.
- **With warm-up**: Agent starts slower by 2-3 seconds, but all subsequent capability queries are instant.

For interactive sessions (Telegram-driven), cold-start latency on the first substantive query will be noticeable to the user. The spec should recommend a middle path: pre-warm the *identity and capabilities index* node (the 20-line capability summary) at session start, but defer full node content to on-demand queries.

### Observation: The Compaction Recovery Hook Has an Unsolved Problem

The spec updates the compaction-recovery hook to output "seed + full AGENT.md + MEMORY.md (as today, but smaller seed)." This is correct for identity recovery, but it assumes the tree is available post-compaction.

Post-compaction, the agent has lost all cached tree results from the session. If it was mid-task and needed a capability reference, that reference is now gone and must be re-fetched — at cold-cache latency. The spec doesn't address whether compaction recovery should also pre-warm frequently-used nodes from the session's history. This is a real-world friction point in long sessions.

---

## Research Findings

### Industry Patterns for Context Management

**CrewAI** uses a provider-neutral RAG client with explicit `score_threshold` (default 0.35) and `results_limit` (default 3) parameters. Agents receive explicit signal when results fall below threshold — they don't receive low-confidence results silently. The Instar tree spec should adopt an equivalent pattern: agents should receive confidence metadata with every search response, and empty results should be explicit (not just empty content).

**Anthropic's Building Effective Agents** guide emphasizes: "treat tool definitions with just as much prompt engineering attention as your overall prompts." The seed's "Self-Knowledge Tree pointer" section is effectively a tool definition — it needs the same level of care: example usage, edge cases, input format requirements, and what to do when results aren't useful.

**LangSmith evaluation patterns**: The online → offline feedback loop principle (production failures become new offline test cases) applies directly to the tree's LLM triage. When an agent queries the tree and the result doesn't help it accomplish the task, that mismatch should be capturable as a test case. The spec's test infrastructure should include a mechanism for agents to signal "this tree result didn't help" — feeding the triage's training data.

**RAG industry consensus on irrelevant results**: The standard pattern is relevance scoring exposed to the caller, with an explicit "no results above threshold" signal (not a low-scoring result returned anyway). The Instar spec should match this — define a minimum confidence threshold below which the tree returns "no confident match, try: [list of related nodes]" rather than a questionable result.

---

## Scalability Assessment

The architecture scales correctly in the long run. The critical insight — that `file_section` from dedicated context files is more scalable than `memory_search` — is right. As capabilities grow, the tree grows by adding nodes and context files, not by inflating CLAUDE.md.

The one scalability concern is the tree's LLM triage cost at scale. The spec mentions "LLM quota exhausted" as a degraded mode but doesn't address the economics of LLM triage for 35+ nodes across 3+ agents with 4+ sessions/day. If every capability query triggers an LLM triage call, the triage cost could approach the savings from the smaller CLAUDE.md. The rule-based fallback is the right answer here, and the spec should make the rule-based path the *primary* path (fast, zero-cost) with LLM triage as the fallback for ambiguous queries — not the reverse.

---

## Score: 7/10

**Justification**: The spec is architecturally correct, the token savings math is real, and the test suite is more thorough than most migration specs. The `file_section` decision is particularly good. The score is reduced by three significant gaps: (1) the irrelevant result recovery path is entirely missing, (2) the tree query API is undefined from the agent's perspective, and (3) the anti-pattern timing problem is unresolved. These gaps will cause measurable agent friction in the first 5 minutes — exactly the window that matters most for a knowledge retrieval migration. Address these in the spec before Phase 3 begins, and this is an approve.

---

## Summary of Required Changes Before Approval

| Priority | Issue | Resolution |
|----------|-------|------------|
| Critical | No recovery path for irrelevant tree results | Define confidence scoring + "no match" signal in tree API contract |
| Critical | Tree query API undefined in agent-facing terms | Specify the actual endpoint/command in the seed's tree pointer section |
| Critical | Anti-pattern loading timing unresolved | Put top 5-7 highest-consequence anti-patterns in the seed |
| Recommended | No capability summary in seed | Add 20-line one-liner-per-capability index |
| Recommended | No agent-facing tree introspection endpoints | Document `/self-knowledge/nodes` and `/self-knowledge/nodes/{id}` |
| Recommended | Single vs. many context files unresolved | Use many files with `context/capabilities/{node-id}.md` convention |
| Recommended | Phase ordering: scaffold before pilot | Pilot Echo first, use learnings to inform scaffold template |
| Recommended | Session cold-start warm-up unresolved | Pre-warm capabilities index node at session start, not full content |
