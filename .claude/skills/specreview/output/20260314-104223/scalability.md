# Scalability Review: Seed Migration Spec (CLAUDE.md → Self-Knowledge Tree)

**Reviewer**: Scalability & Infrastructure Specialist
**Spec**: `specs/seed-migration.md` (Draft v1, 2026-03-13)
**Review Date**: 2026-03-14

---

### Approval Status: CONDITIONAL

The spec is well-reasoned and addresses a real problem (runaway context cost). The core design is sound. However, several scalability risks are unaddressed or underspecified — particularly around LLM triage cost scaling, cache invalidation, and the "one big reference file" decision. These are not blocking individually, but together they could undermine the token savings the spec promises. Conditional approval: fix the critical issues before Phase 2 begins.

---

## Critical Issues (must fix before building)

### 1. LLM Triage Is an Unbounded Cost Multiplier

**Why it matters**: The spec projects savings of ~4,400 tokens/session (from 17,600 to ~6,000). But it doesn't account for the triage cost. Every tree query sends a request to an LLM (Claude) to determine which node to route to. If the LLM triage costs 500–1,500 tokens per call (system prompt + node list + query + response), and a session triggers 3–5 queries, the triage cost alone is 1,500–7,500 tokens/session — potentially wiping out the savings entirely.

At 100x scale (300 agents, 40 sessions/day): triage overhead dominates unless cache hit rates are extremely high. The spec claims "> 60% cache hits after warmup" as a success criterion, but 40% cold calls at 100x scale is a massive token burn.

**The spec says**: "~2,000 on-demand" for tree-served content. This appears to count only the retrieved context, not the triage LLM call itself. This is a gap in the cost model.

**Suggested fix**: Enumerate triage call costs explicitly. Add to the cost table: (a) triage prompt tokens, (b) expected calls per session, (c) cache hit rate assumption. Validate the net token savings model before building. Consider whether the triage LLM can be replaced with cheaper embedding-based similarity search for the first routing pass, with LLM only for ambiguous cases.

---

### 2. Cache Invalidation Strategy Is Absent

**Why it matters**: The spec mentions caching as a given ("Subsequent searches use cache") but never defines: what is cached, for how long, keyed on what, and — critically — when it is invalidated.

This matters for correctness as the system scales:
- If a capability's documentation is updated in `capabilities-reference.md`, does the cache reflect it? When?
- If a new tree node is added, does the old cache incorrectly miss it?
- If the tree config is updated (Phase 2), do all agents pick up the change immediately or after cache expiry?

At 10x scale (30 agents), stale cache = 30 agents operating with wrong knowledge simultaneously. At 100x (300 agents), this becomes a systemic coherence failure.

**Suggested fix**: Define the cache key schema (query text? embedding hash? node ID?), TTL policy (hard expiry vs. staleness detection), and invalidation triggers (file change detection on `capabilities-reference.md`, tree config version bump). The cache must be versioned alongside the tree config.

---

### 3. Single Context File Is a Scaling and Coherence Bottleneck

**Why it matters**: The spec proposes one large `capabilities-reference.md` (~650 lines) as the source of truth for all Tier 2 content. The `file_section` retrieval extracts sections by heading. As the tree grows, this creates two compounding problems:

1. **Retrieval pollution**: When extracting a section by heading, the tree node must determine where the section ends. In a 650-line file with 35+ sections, adjacent sections bleed into each other if the heading-extraction logic isn't airtight. The spec doesn't define the extraction boundary rules.

2. **Contention and merge conflicts**: Every new instar feature requires editing this one file. At 10x agent types or 10x features per cycle, the file becomes a shared mutable resource — a classic coordination bottleneck. Git merge conflicts, partial updates mid-session, and stale reads all increase in probability with file size.

At 1000x (the viral spike scenario): a single 650-line file with 35+ sections, each being extracted independently by hundreds of agents querying simultaneously, is a correctness and performance liability.

**Suggested fix**: The spec's own Open Question #4 identifies this ("One big file or many small files?"). Resolve it in favor of **one file per capability domain** (e.g., `context/publishing.md`, `context/jobs.md`). The tree node then points to the entire file, not a section within a larger file. File-level extraction is simpler, less error-prone, and allows independent versioning. The single-file simplicity argument is weaker than the correctness argument.

---

### 4. Anti-Pattern Loading Strategy Is Unresolved at a Behavioral Correctness Level

**Why it matters**: The spec explicitly flags this as an Open Question (#5): "Anti-patterns are most valuable when the agent is about to violate them — but by then it's too late to load them." This is not a nice-to-have question. It's a behavioral coherence failure mode.

If anti-patterns are loaded on-demand based on task context, the triage must correctly predict that a given task will require anti-pattern guidance *before* the agent acts. LLM triage for this is circular — the agent that might violate an anti-pattern is also the agent that decides whether to load the anti-pattern guard.

At 10x scale (more agents, more task types): the probability that triage misclassifies a task as not requiring anti-pattern guidance increases. False negatives here are invisible and dangerous — the agent proceeds without the guard, makes a bad decision, and there's no signal that the tree failed to load the right context.

**Suggested fix**: The top 3–5 highest-risk anti-patterns (File and Wait, Escalate to Human, GitHub Issues, Answer From Memory, Defensive Fabrication) must stay in the seed. These are low-token cost (20–30 lines) and catastrophic when violated. The full anti-pattern and gravity wells content can remain tree-served. This is the right tradeoff — not all behavioral content has equal risk profiles.

---

## Recommendations (should fix, not blocking)

### 5. The Token Savings Projection Lacks a Confidence Interval

The spec presents a precise projection: "17,600 → ~4,000 static + ~2,000 on-demand." The on-demand figure of 2,000 tokens assumes the agent queries the tree an average of 1–2 times per session. At peak complexity sessions (multi-capability tasks), a single conversation could trigger 5–10 tree queries. The spec's test "Multi-capability task: Set up a daily job that checks CI and sends me results" alone spans 3 capability domains. Model the distribution, not just the mean.

**Suggested fix**: Add a per-session tree query distribution estimate (min/median/max) and compute token costs for the p50 and p95 cases.

---

### 6. Cross-Agent Cache Sharing Is Not Addressed

Multiple agents (Echo, AI Guy, test agents) querying the same tree over the same content files — do they share a cache, or does each agent maintain independent caches? The spec mentions "3 agents, 4 sessions/day" in its cost model, implying agents are independent. But if the same query ("how do I publish?") is answered from a cold cache by each agent independently, cache warmup efficiency is much lower than the spec implies.

At 100x (300 agents), per-agent caches mean 300 independent cache warmups for identical queries. A shared cache keyed on (tree config version, query hash) would reduce cold calls dramatically.

**Suggested fix**: Define cache scope (per-agent vs. shared). If the server at port 4042 hosts the tree, a shared cache at the server level is already architecturally possible — make it explicit.

---

### 7. "1000 Agents Migrate at Once" Scenario Is Unaddressed

The Phase 6 rollout is described as "broad rollout" without a migration rate limit. If 1000 agents all run the upgrade script simultaneously: all read from `capabilities-reference.md`, all regenerate tree configs, all run validation queries. The instar server (and any shared infrastructure) sees a spike.

**Suggested fix**: Add a staggered rollout mechanism (e.g., upgrade script reads a rollout percentage flag, agents self-select based on a hash of their agent ID). Phase 6 should specify a rollout rate (e.g., 10% per day, with health monitoring gates).

---

### 8. Tree Node Depth and Coherence at Scale

The spec targets ~35 nodes across 5 layers. The current tree has 13 nodes. As instar adds features, the tree will grow. The spec doesn't define a maximum depth or node count, or how triage accuracy degrades as the node space grows.

LLM-powered triage routing accuracy is inversely correlated with the number of candidates. At 35 nodes, accuracy is likely high. At 200 nodes (3 years of growth at current trajectory), accuracy degrades — the LLM must distinguish between increasingly similar-sounding nodes.

**Suggested fix**: Define a node taxonomy governance model. As new capabilities are added, where do nodes go? What prevents the tree from becoming as bloated as CLAUDE.md? Consider a maximum of 50 nodes with mandatory consolidation reviews when approaching that limit.

---

### 9. Test Suite Uses Real Claude Sessions — Cost and Flakiness Risk

Category 1–5 tests spawn real Claude Code sessions and use LLM grading (Haiku). This is correct for semantic evaluation but introduces two risks:

1. **Cost**: 40+ test cases × 2 agents (monolith + seed) × real sessions = significant token cost per test run. If the test suite runs on every phase gate, this adds up. The spec doesn't estimate test suite token cost.

2. **Flakiness**: LLM-graded tests are non-deterministic. A test that passes 4/5 times creates false confidence. The spec doesn't define a required pass rate (e.g., "must pass 9/10 runs").

**Suggested fix**: Separate tests into deterministic (regex/JSON — run on every commit) and LLM-graded (semantic — run only on phase gate transitions). Define a minimum pass rate for LLM-graded tests (suggest 90% over 5 runs).

---

## Observations (nice to know)

- **The "search count of zero" problem**: The tree shipped in v0.19.0 and has never been used. This review should note that the scalability concerns are somewhat theoretical — the biggest risk may not be technical but adoption: the tree remains unused again because the seed model doesn't make tree queries feel natural to the agent. The test suite's Category 2 tests are the right mitigation.

- **Open Question #1 (capability summary in seed)**: The spec leaves this open. From a scalability lens, a static one-line-per-capability list (~20 lines, ~400 tokens) in the seed dramatically reduces triage cold-start costs. Agents know what exists without querying the tree, so they only query when they need the full docs. This is worth the 400-token cost.

- **Open Question #3 (proactive session-start load)**: The spec asks whether the capabilities layer should load at session start (2,000 tokens, immediate awareness). At 10x scale, this is a straightforward cost multiplier. The better answer is: load the *index* (one-line summaries, ~400 tokens) at start; load *full sections* on demand. This gives awareness without the full load.

- **File-section extraction reliability**: The spec trusts heading-match extraction to be reliable. This works cleanly until: (a) headings are renamed, (b) sub-headings create ambiguous matches, or (c) the extraction reads past the section end. This is a content-format dependency that will cause silent failures as files grow. Worth a note in the implementation guide.

- **Rollback plan is solid**: The backup-based rollback is clean. The session-start hook health check → fallback to monolith is particularly good. This degrades gracefully.

---

## Research Findings

### LLM-Powered Search/Triage at Scale

LLM routing accuracy follows a pattern seen in RAG systems: accuracy peaks when candidate space is small (< 50 options) and degrades nonlinearly beyond that. At 35 nodes, the tree is well within the high-accuracy zone. The risk is future growth.

Embedding-based similarity (vector search) is typically 10–100x cheaper per call than LLM triage, with accuracy that's competitive for well-separated semantic spaces. Hybrid approaches (embedding for first-pass candidate selection, LLM for disambiguation) are the production pattern at scale. The spec's mention that "rule-based keyword triage" exists as a fallback is good — but keyword matching and embedding similarity are different capabilities. Worth distinguishing.

### Caching Strategies for RAG/Retrieval Systems

Semantic caching (caching by query similarity rather than exact query text) is the standard approach for LLM retrieval systems. It requires an embedding index of past queries, but dramatically increases cache hit rates compared to exact-match caching. A query "how do I share a document?" and "how do I publish something?" would miss on exact-match cache but hit on semantic cache.

The tradeoff: semantic cache requires more infrastructure (embedding model, vector index). For 3–30 agents, exact-match cache is probably sufficient. For 300+ agents, semantic caching delivers the cache hit rates the spec assumes.

TTL-based invalidation is fragile for content that changes irregularly. Event-driven invalidation (file watcher on `capabilities-reference.md` → clear affected cache entries) is more correct. Most production RAG systems use both: short TTL for freshness, event-driven invalidation for correctness.

### Token Cost Optimization for Agent Context Management

The core insight from production agent systems: the right unit of context loading is not "document" but "claim" — the specific fact the agent needs to complete the current action. The spec's file_section approach loads entire sections (potentially 200–500 tokens) when the agent may only need one API endpoint URL (20 tokens). This is a known inefficiency in RAG systems called "over-retrieval."

At 10x scale, the difference between retrieving 500-token sections vs. 50-token claims is an order of magnitude in context cost. The spec's approach is pragmatic and correct for Phase 1 — but the tree's future evolution should move toward finer-grained retrieval.

The "chunk at section boundaries" approach the spec uses is standard and generally correct. The risk is long sections (the spec's Tier 2 table has some entries that map to very long current CLAUDE.md sections — Telegram Relay, Anti-Patterns).

---

## Scalability Assessment

### Phase 1 MVP (3 agents, current load)

**Status: Manageable.** The token savings are real and the architecture is correct. The main risk is the triage cost model gap — verify actual savings against actual LLM triage call costs before declaring victory. The 60% cache hit target is achievable at this scale.

**Projected actual savings**: 60–70% token reduction (vs. spec's 65% claim), dependent on triage call cost assumptions being validated.

### Phase 2 Growth (10x: 30 agents, 40 sessions/day)

**Status: Requires cache scope decision.** Per-agent caches at 30 agents means 30 independent warmups for identical queries. Total cache miss cost grows linearly. A server-level shared cache is the correct fix — it's architecturally available (all agents hit port 4042) and reduces warmup cost by 10–30x.

**Key risk**: Cache invalidation. At 30 agents, a stale cache that all agents share is 30x more impactful than a stale per-agent cache. The invalidation strategy must be defined before this phase.

**Query pattern risk**: As agents vary in task types, triage must handle more diverse query intents. Accuracy held — the 35-node tree is still navigable.

### Phase 3 Scale (100x: 300 agents, 400 sessions/day)

**Status: Two bottlenecks emerge.**

1. **Triage cost**: At 40% cold call rate, 400 sessions/day, ~3 queries/session = 480 LLM triage calls/day at cold rate. At 1,000 tokens/triage call, that's 480K tokens/day in triage overhead alone — approaching the current baseline token burn.

2. **Single reference file contention**: 300 agents reading from one file simultaneously isn't a filesystem issue (reads are cheap) — but the maintenance burden of one 650-line file touched by every feature cycle becomes a real coordination cost for the instar development team.

**Fix required before Phase 3**: Move to per-capability files (resolving Open Question #4 in favor of many small files) and implement semantic caching or embedding-based first-pass routing.

### Viral Spike (1000 agents, simultaneous migration)

**Status: Needs rate limiting.** Without a staggered rollout, the Phase 6 "broad rollout" is a thundering herd problem. 1000 agents simultaneously:
- Backing up (disk I/O spike)
- Extracting content (CPU spike)
- Regenerating tree configs (redundant work — configs are identical)
- Running validation queries (LLM API rate limit risk)

**Fix**: Staggered migration with a coordination API endpoint (`GET /migration/my-slot`) that returns the scheduled migration window for each agent based on agent ID hash. Prevents simultaneous migration and distributes load.

---

## Score: 7/10

**Justification**: The spec correctly identifies the problem, makes the right core design decisions (seed + tree, file_section over memory_search, graceful degradation), and has an unusually thorough test suite. It loses points for: an incomplete cost model that may understate triage overhead (critical), an absent cache invalidation strategy (critical), and leaving the single-vs-many reference file question open when the scalability answer is clear. Fix the critical issues and this is an 8.5. The foundation is solid — the execution risks are in the infrastructure details.
