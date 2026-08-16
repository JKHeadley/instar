# Scalability Review: Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVAL** | **Score: 4/10**

## Critical Issues

**1. LLM Compilation Has No Cost Model or Rate Limiting (HIGH)**
Profile compilation from AGENT.md + MEMORY.md + git history etc. could hit 50–200K tokens per agent. At 500 agents with weekly recompilation: $400–$600/month. At 5,000 agents: $4,000–$6,000/month. No debouncing, rate limiting, or tiered model routing is specified. A MEMORY.md that gets written 50 times per session could trigger 50 recompilations without guardrails.

**2. Discovery Response Payload Is Undefined and Likely Oversized (HIGH)**
Sending full rich profiles in discovery responses is a critical architecture mistake. At 1,000 agents, a broadcast discovery could return 500KB–2MB per query. The fix: a two-tier pattern — a compact Discovery Card (≤1KB, cached aggressively) for discovery, and a full Rich Profile fetched on-demand. This is also the A2A Protocol standard.

**3. No Database/Storage Model Specified (HIGH)**
Rich profiles need: document store for narrative content, vector store for semantic search, graph layer for relationships, and event log for versioning. These have radically different scaling characteristics. No storage model = implementation-phase land mine.

**4. Profile Freshness Triggers Are Undefined (MEDIUM)**
"Event-driven updates" is a category, not a spec. Without debouncing, a busy agent could trigger hundreds of LLM recompiles per day. Minimum 24-hour TTL between compilations required.

**5. No Indexing or Search Strategy (MEDIUM)**
At 500+ agents, full-text search over unindexed narrative text is non-functional. Vector embeddings for semantic capability matching are needed but unspecified.

## Key Recommendations

1. **Adopt two-tier profile pattern**: Discovery Card + Rich Profile fetched on demand
2. **Build a compilation pipeline**: Haiku for structured extraction → Sonnet for narrative synthesis → embedding generation. 50–70% cost reduction vs. monolithic synthesis.
3. **Dirty-flag + batch recompile pattern**: decouple writes from LLM calls
4. **Start with Postgres + pgvector**: handles all query patterns through Growth phase; defer graph DB
5. **Cap compilation context budget**: ≤20K tokens total per agent (AGENT.md 8K, MEMORY.md 4K recency-weighted, git history summary only 2K)

## Phase Assessment

- **MVP (10–50 agents)**: Viable. Cost ~$15–30/month. Don't encode bad patterns now.
- **Growth (50–500 agents)**: Requires the architecture decisions above. Poorly designed: $500–2,000/month in LLM costs alone.
- **Scale (500–5,000 agents)**: Needs explicit horizontal scaling design not present in the spec.
- **Viral (5,000+ in days)**: Not designed for. Would require re-architecture without queue-backed compilation workers.

## The Three Decisions That Must Be Made Before Implementation

1. Two-tier profile structure (Discovery Card + Rich Profile)
2. Storage model (Postgres + pgvector is the correct start)
3. Compilation pipeline architecture (dirty-flag + batch + tiered model routing)

The concept is sound. The execution path as implied is not — but it's fixable with three upfront architectural decisions.
