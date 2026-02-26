# PROP: Mature Memory Architecture for Instar

> **Version**: 1.0
> **Date**: 2026-02-25
> **Status**: Draft — awaiting review
> **Author**: Dawn (Inside-Dawn, builder instance)
> **Instar Version**: 0.9.17 (baseline)
> **Target Version**: 0.10.x

---

## Problem Statement

Instar agents accumulate knowledge across sessions but lack a coherent memory architecture. The current system is a collection of independent subsystems that don't cross-pollinate:

| System | Format | What it knows | What it can't do |
|--------|--------|---------------|------------------|
| MEMORY.md | Flat markdown | Anything the agent wrote | Scale, decay, connect, retrieve by relevance |
| TopicMemory | SQLite + JSONL | Conversation history | Connect conversations to knowledge |
| Relationships | JSON files | People and interactions | Connect people to topics or knowledge |
| CanonicalState | JSON files | Quick facts, anti-patterns | Evolve, connect, forget |
| DecisionJournal | JSONL | Past decisions | Inform future ones (no retrieval by similarity) |
| MemoryIndex | SQLite FTS5 | Text search over files | Understand meaning, only keyword match |

**The core problem**: These systems are *silos*. A learning about an API endpoint lives in MEMORY.md. The person who built that API lives in relationships/. The conversation where the agent discovered the endpoint lives in TopicMemory. The decision to use that API lives in DecisionJournal. Nothing connects them.

**Scaling problems**:
1. **MEMORY.md doesn't scale** — At 5K words it's noise, at 10K it actively hurts context
2. **No relevance-based retrieval** — Context loading is all-or-nothing (FTS5 is keyword matching, not semantic)
3. **No forgetting** — Old facts have equal weight to verified current facts
4. **No connections** — Knowledge is isolated in silos with no cross-references
5. **No confidence tracking** — A guess from 3 months ago looks identical to a verified fact from today

---

## Design Goals

1. **Scale gracefully** — 10 facts or 10,000 facts, same retrieval quality
2. **Retrieve by relevance** — "What do I know about deployment?" returns deployment knowledge, not everything
3. **Connect knowledge** — People, conversations, facts, and decisions form a web, not isolated lists
4. **Forget gracefully** — Knowledge decays unless verified; the agent stays current, not encyclopedic
5. **Migrate incrementally** — No big-bang migration; current systems continue working throughout
6. **Stay file-based** — No external database server; SQLite + JSON only (Instar's core portability promise)
7. **LLM-supervised quality** — The agent curates its own memory, not just accumulates

---

## Architecture Overview

### The Three Memory Systems

Drawing from cognitive science and Dawn's operational experience, a mature agent memory has three layers:

```
                    ┌─────────────────────────────┐
                    │     WORKING MEMORY           │
                    │  (Session context window)     │
                    │  What I'm thinking about now  │
                    └──────────────┬──────────────┘
                                   │ retrieves from
                    ┌──────────────▼──────────────┐
                    │     SEMANTIC MEMORY           │
                    │  (Structured knowledge graph)  │
                    │  Facts, entities, connections  │
                    └──────────────┬──────────────┘
                                   │ summarized from
                    ┌──────────────▼──────────────┐
                    │     EPISODIC MEMORY           │
                    │  (Session digests + raw logs)  │
                    │  What happened, what I learned │
                    └─────────────────────────────┘
```

**Episodic Memory** = What happened (sessions, conversations, events)
**Semantic Memory** = What I know (facts, entities, relationships, patterns)
**Working Memory** = What's relevant right now (session-specific context injection)

### Why Not a Full Knowledge Graph?

Knowledge graphs (Neo4j, etc.) are powerful but violate Instar's core constraint: **no external database servers**. The right level of graph-ness for Instar is:

- **Yes**: Entities with typed relationships and confidence scores
- **Yes**: Bidirectional connections between facts, people, topics
- **Yes**: Traversal queries ("what do I know about things related to X?")
- **No**: Full graph query language (Cypher, SPARQL)
- **No**: Running database server
- **No**: Schema-first rigid ontology

**The solution**: A lightweight entity-relationship store in SQLite, with a JSON export for portability and disaster recovery. Graph *concepts* without graph *infrastructure*.

---

## Detailed Design

### Phase 1: Semantic Memory Store (SQLite + JSON)

**New file**: `src/memory/SemanticMemory.ts`

#### Entity Model

```typescript
interface MemoryEntity {
  id: string;                    // UUID
  type: EntityType;              // 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson'
  name: string;                  // Human-readable label
  content: string;               // The actual knowledge (markdown)
  confidence: number;            // 0.0 - 1.0 (how sure are we?)

  // Temporal
  createdAt: string;             // When first recorded
  lastVerified: string;          // When last confirmed true
  lastAccessed: string;          // When last retrieved for a session
  expiresAt?: string;            // Optional hard expiry (e.g., "API key rotates monthly")

  // Provenance
  source: string;                // Where this came from ('session:ABC', 'observation', 'user:Justin')
  sourceSession?: string;        // Session ID that created this

  // Classification
  tags: string[];                // Free-form tags for filtering
  domain?: string;               // Optional domain grouping ('infrastructure', 'relationships', 'business')
}

type EntityType = 'fact' | 'person' | 'project' | 'tool' | 'pattern' | 'decision' | 'lesson';
```

#### Relationship Model

```typescript
interface MemoryEdge {
  id: string;                    // UUID
  fromId: string;                // Source entity
  toId: string;                  // Target entity
  relation: RelationType;        // Type of connection
  weight: number;                // 0.0 - 1.0 (strength of connection)
  context?: string;              // Why this connection exists
  createdAt: string;
}

type RelationType =
  | 'related_to'       // Generic association
  | 'built_by'         // Person → Project/Tool
  | 'learned_from'     // Lesson → Session/Person
  | 'depends_on'       // Project → Tool/API
  | 'supersedes'       // New fact → Old fact
  | 'contradicts'      // Fact → Fact (conflict detection)
  | 'part_of'          // Component → System
  | 'used_in'          // Tool → Project
  | 'knows_about'      // Person → Topic
  | 'caused'           // Event → Consequence
  | 'verified_by';     // Fact → Session (re-verification)
```

#### SQLite Schema

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  created_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  expires_at TEXT,
  source TEXT NOT NULL,
  source_session TEXT,
  domain TEXT,
  tags TEXT NOT NULL DEFAULT '[]',  -- JSON array

  -- Computed: effective_weight = confidence * recency_decay
  -- Used for retrieval ranking
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5,
  context TEXT,
  created_at TEXT NOT NULL,

  UNIQUE(from_id, to_id, relation)
);

-- Full-text search over entity content
CREATE VIRTUAL TABLE entities_fts USING fts5(
  name, content, tags,
  content=entities,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Index for efficient type + domain queries
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_domain ON entities(domain);
CREATE INDEX idx_entities_confidence ON entities(confidence);
CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to ON edges(to_id);
CREATE INDEX idx_edges_relation ON edges(relation);
```

#### Core Operations

```typescript
class SemanticMemory {
  // ── Create & Update ──

  /** Record a new fact, lesson, pattern, etc. */
  remember(entity: Omit<MemoryEntity, 'id' | 'createdAt' | 'lastAccessed'>): string;

  /** Connect two entities */
  connect(fromId: string, toId: string, relation: RelationType, context?: string): string;

  /** Update confidence after verification */
  verify(id: string, newConfidence?: number): void;

  /** Mark an entity as superseded by a newer one */
  supersede(oldId: string, newId: string, reason: string): void;

  // ── Retrieval ──

  /** Search by text relevance (FTS5 + confidence + recency) */
  search(query: string, options?: {
    types?: EntityType[];
    domain?: string;
    minConfidence?: number;
    limit?: number;
  }): ScoredEntity[];

  /** Get an entity and its connections (1-hop neighborhood) */
  recall(id: string): { entity: MemoryEntity; connections: ConnectedEntity[] };

  /** Find entities related to a topic (graph traversal) */
  explore(startId: string, options?: {
    maxDepth?: number;    // Default: 2
    relations?: RelationType[];
    minWeight?: number;
  }): MemoryEntity[];

  /** Get context for a session — the "working memory loader" */
  getRelevantContext(query: string, options?: {
    maxTokens?: number;   // Default: 2000
    types?: EntityType[];
  }): string;  // Formatted markdown for session injection

  // ── Maintenance ──

  /** Apply confidence decay to all entities */
  decayAll(halfLifeDays?: number): DecayReport;

  /** Find low-confidence or expired entities */
  findStale(options?: { maxConfidence?: number; olderThan?: string }): MemoryEntity[];

  /** Remove an entity and its edges */
  forget(id: string, reason: string): void;

  /** Export to JSON (for backup, git state, portability) */
  export(): { entities: MemoryEntity[]; edges: MemoryEdge[] };

  /** Import from JSON (migration, restore) */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport;

  /** Statistics */
  stats(): SemanticMemoryStats;
}
```

#### Retrieval Scoring

The key innovation: **multi-signal ranking** that combines text relevance, confidence, and recency.

```
score = (fts5_rank * 0.4) + (confidence * 0.3) + (recency_decay * 0.2) + (access_frequency * 0.1)

where:
  fts5_rank     = BM25 text relevance score (normalized 0-1)
  confidence    = entity.confidence (0-1)
  recency_decay = exp(-0.693 * days_since_verified / half_life_days)
  access_freq   = min(1.0, access_count / 10)  // Frequently accessed = more relevant
```

This means:
- A verified fact from yesterday ranks higher than an unverified claim from last month
- A frequently-accessed entity ranks higher than a rarely-used one
- Text relevance is still the primary signal, but it's modulated by quality indicators

#### Confidence Decay

Every 24 hours (or on-demand), `decayAll()` reduces confidence:

```
new_confidence = confidence * exp(-0.693 * days_since_verified / half_life_days)
```

Default half-life: **30 days**. A fact not re-verified in 30 days drops to 50% confidence. In 60 days, 25%. In 90 days, 12.5%.

**Why this matters**: An agent that learned "the API endpoint is at /v1/users" 90 days ago and never re-verified it should treat that knowledge with appropriate skepticism. The decay doesn't delete the fact — it makes it rank lower in retrieval, so fresh verified knowledge surfaces first.

**Exemptions**: Entities with `expiresAt: null` and `type: 'lesson'` have a longer half-life (90 days). Hard-won lessons should persist longer than factual observations.

### Phase 2: Episodic Memory (Session Digests)

**New file**: `src/memory/EpisodicMemory.ts`

Every session produces a **digest** — a structured summary of what happened, what was learned, and what matters.

```typescript
interface SessionDigest {
  sessionId: string;
  sessionName: string;
  startedAt: string;
  endedAt: string;
  jobSlug?: string;

  // What happened
  summary: string;                // 2-3 sentence overview
  actions: string[];              // Key actions taken

  // What was learned
  entities: string[];             // IDs of entities created/updated
  learnings: string[];            // Key insights (free text)

  // What matters
  significance: number;           // 1-10
  themes: string[];               // Topic tags
  followUp?: string;              // What the next session should do
}
```

**How digests are created**: The existing `reflection-trigger` job is extended to:
1. Read the session's activity log
2. Summarize into a SessionDigest
3. Extract entities (facts, lessons, patterns) into SemanticMemory
4. Store the digest in episodic storage

**Storage**: `state/episodes/{sessionId}.json` (one file per session)

**Retrieval**:
- By time range: "What happened in the last 24 hours?"
- By theme: "What sessions touched deployment?"
- By significance: "What were the most important sessions this week?"

### Phase 3: Working Memory (Context-Aware Retrieval)

**Enhancement to**: `src/core/ContextHierarchy.ts`

The working memory layer assembles the right context for each session from all memory systems:

```typescript
interface WorkingMemoryAssembly {
  /** Identity grounding (Tier 0 — always) */
  identity: string;

  /** Relevant semantic knowledge (Tier 1 — session-specific) */
  knowledge: string;           // Top-ranked entities from SemanticMemory.search()

  /** Recent episode context (Tier 1) */
  recentEpisodes: string;      // Last 2-3 session digests

  /** Relationship context (Tier 1, if person detected) */
  relationships: string;       // Relevant relationship records

  /** Topic history (Tier 1, if topic detected) */
  topicContext: string;        // TopicMemory summary + recent messages

  /** Job-specific context (Tier 1, if job session) */
  jobContext: string;          // Handoff notes + last job state

  /** Total token estimate */
  estimatedTokens: number;
}
```

**Assembly strategy**:
1. Parse the session trigger (message, job prompt) to identify topics
2. Query SemanticMemory for relevant entities
3. Check for related people (person entities connected to topic entities)
4. Load episode digests for continuity
5. Budget tokens across sources (identity: 200, knowledge: 800, episodes: 400, relationships: 300, topic: 300)
6. Return formatted context for session-start hook injection

### Phase 4: Migration from Current Systems

**Critical constraint**: Migration is incremental. Current systems keep working throughout.

#### Step 1: SemanticMemory Ingestion (Automated)

A one-time migration job + ongoing sync:

1. **MEMORY.md → entities**: Parse headings as entities, content as knowledge. Each section becomes a `fact` or `pattern` entity. Confidence = 0.7 (not recently verified).

2. **Relationships → person entities + edges**: Each relationship becomes a `person` entity. Interaction themes become `knows_about` edges. Significance maps to confidence.

3. **CanonicalState → entities**: Quick facts become `fact` entities (confidence = 0.95). Anti-patterns become `lesson` entities. Project registry entries become `project` entities.

4. **DecisionJournal → decision entities + edges**: Each decision becomes a `decision` entity with `caused` edges to the entities it affected.

#### Step 2: Dual-Write Period

For 2-3 releases, both old and new systems receive writes:
- MEMORY.md continues to be updated (backward compatibility)
- SemanticMemory also receives the same knowledge
- MemoryIndex continues to work as before
- SemanticMemory's FTS5 provides an alternative search path

#### Step 3: Gradual Cutover

Once SemanticMemory proves reliable:
- New sessions prefer SemanticMemory for retrieval
- MEMORY.md becomes a human-readable export (still generated, no longer primary)
- MemoryIndex deprecated in favor of SemanticMemory's built-in FTS5
- Relationships continue in their own format but gain edges in SemanticMemory

#### Step 4: MEMORY.md as Generated Artifact

MEMORY.md transitions from "source of truth" to "generated snapshot":
- Periodically regenerated from SemanticMemory (top entities by confidence)
- Still loaded by session-start hooks (backward compatible with existing agents)
- Agents that haven't updated continue working as before
- Updated agents use SemanticMemory directly for retrieval

---

## Implementation Plan

### Phase 1: SemanticMemory Core (v0.10.0)
**Effort**: 2-3 sessions
**Files**:
- `src/memory/SemanticMemory.ts` — Core entity/edge store
- `tests/unit/semantic-memory.test.ts` — Entity CRUD, search, decay, export/import
- `src/server/routes.ts` — API endpoints: GET/POST /memory/semantic, /memory/semantic/search

**Deliverables**:
- Entity and edge CRUD operations
- FTS5 search with multi-signal ranking
- Confidence decay engine
- JSON export/import
- API routes for management and search

### Phase 2: Migration Engine (v0.10.1)
**Effort**: 1-2 sessions
**Files**:
- `src/memory/MemoryMigrator.ts` — Ingests MEMORY.md, relationships, canonical state
- `src/commands/memory.ts` — CLI commands: `instar memory migrate`, `instar memory stats`
- Job: `memory-migration` (one-time)

**Deliverables**:
- Automated ingestion from all existing memory sources
- Dual-write hooks in existing managers
- CLI for manual migration and inspection

### Phase 3: Episodic Memory (v0.10.2)
**Effort**: 1-2 sessions
**Files**:
- `src/memory/EpisodicMemory.ts` — Session digest storage
- Enhancement to `reflection-trigger` job — Produces structured digests
- Enhancement to session completion hooks — Trigger digest creation

**Deliverables**:
- Session digest capture on completion
- Entity extraction from digests into SemanticMemory
- Time-range and theme-based episode retrieval

### Phase 4: Working Memory Assembly (v0.10.3)
**Effort**: 1-2 sessions
**Files**:
- Enhancement to `src/core/ContextHierarchy.ts` — Uses SemanticMemory for Tier 1/2
- Enhancement to session-start hook — Injects relevant context
- Enhancement to compaction-recovery hook — Re-injects from SemanticMemory

**Deliverables**:
- Context-aware session bootstrapping
- Token-budgeted assembly from all memory layers
- Seamless integration with existing hook system

### Phase 5: MEMORY.md Generation & Cutover (v0.10.4)
**Effort**: 1 session
**Files**:
- `src/memory/MemoryExporter.ts` — Generates MEMORY.md from SemanticMemory
- New job: `memory-export` — Periodic MEMORY.md regeneration
- Deprecation of MemoryIndex in favor of SemanticMemory search

**Deliverables**:
- MEMORY.md as generated artifact
- Backward compatibility preserved
- MemoryIndex deprecated with migration path

---

## Knowledge Graph Concepts: What We Take and What We Leave

### What We Take

| Concept | How We Use It | Why |
|---------|--------------|-----|
| **Typed entities** | EntityType enum (fact, person, project, etc.) | Different knowledge needs different handling |
| **Typed relationships** | RelationType enum (built_by, depends_on, etc.) | Enables meaningful traversal ("who built X?") |
| **Graph traversal** | `explore()` with depth limit | Find related knowledge 1-2 hops away |
| **Edge weights** | Connection strength (0-1) | Some connections are stronger than others |
| **Temporal properties** | Created, verified, accessed timestamps | Knowledge has a lifecycle |
| **Confidence scores** | Per-entity confidence with decay | Not all knowledge is equally trustworthy |

### What We Leave

| Concept | Why We Skip It | What We Do Instead |
|---------|---------------|-------------------|
| **Graph database** (Neo4j, etc.) | Violates file-based portability | SQLite with explicit edges table |
| **Query language** (Cypher, SPARQL) | Overkill for agent use cases | Typed API methods (search, recall, explore) |
| **Rigid ontology** | Agents need flexibility | Loose typing with free-form tags |
| **Full reasoning engine** | Too complex, diminishing returns | LLM handles reasoning over retrieved context |
| **Distributed graphs** | Single agent, single machine | Local SQLite with JSON export |
| **Real-time graph analytics** | Agents don't need PageRank | Simple BFS traversal with depth limits |

### The Principle

We use graph *concepts* (entities, edges, traversal, confidence) implemented in graph-*free* infrastructure (SQLite + JSON). The agent gets 80% of the value of a knowledge graph at 20% of the complexity, with zero operational burden.

---

## API Surface

### Server Endpoints

```
GET    /memory/semantic                    # Stats and overview
GET    /memory/semantic/search?q=QUERY     # FTS5 search with ranking
POST   /memory/semantic/entities           # Create entity
GET    /memory/semantic/entities/:id       # Get entity + connections
PATCH  /memory/semantic/entities/:id       # Update entity
DELETE /memory/semantic/entities/:id       # Forget entity
POST   /memory/semantic/entities/:id/verify  # Re-verify (refresh confidence)
POST   /memory/semantic/edges              # Create edge
DELETE /memory/semantic/edges/:id          # Remove edge
GET    /memory/semantic/explore/:id        # Graph traversal from entity
POST   /memory/semantic/context            # Get relevant context for a query
GET    /memory/semantic/stale              # List low-confidence entities
POST   /memory/semantic/decay              # Trigger confidence decay
POST   /memory/semantic/export             # Full JSON export
POST   /memory/semantic/import             # Full JSON import

GET    /memory/episodes                    # List session digests
GET    /memory/episodes/:sessionId         # Get specific digest
GET    /memory/episodes/search?q=QUERY     # Search episodes
```

### CLI Commands

```bash
instar memory stats              # Overview of all memory systems
instar memory search "query"     # Search across all memory
instar memory migrate            # Run migration from existing systems
instar memory export             # Export to JSON
instar memory import FILE        # Import from JSON
instar memory decay              # Trigger confidence decay
instar memory stale              # List entities needing re-verification
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| SQLite corruption | Memory loss | JSON export every 24h (backup), JSONL source of truth for messages |
| Migration data loss | Knowledge not transferred | Dual-write period, validation report after migration |
| Performance at scale | Slow session starts | Token budgets, indexed queries, lazy loading |
| Over-engineering | Complexity without value | Start with Phase 1 only; validate before proceeding |
| Backward compatibility | Existing agents break | MEMORY.md continues to work; new features are additive |
| Confidence decay too aggressive | Useful knowledge forgotten | Configurable half-life, lessons exempt from fast decay |
| Entity bloat | Too many low-quality entities | memory-hygiene guardian job prunes stale entities |

---

## Success Criteria

1. **An agent with 1000+ entities can retrieve relevant context in <100ms**
2. **Session context quality improves** — sessions start with more relevant knowledge
3. **Knowledge connections discoverable** — "what do I know about X?" returns X + related entities
4. **Stale knowledge identified** — entities older than 60 days without verification are flagged
5. **MEMORY.md stays readable** — generated version is as useful as hand-written version
6. **Zero breaking changes** — existing agents continue working without modification
7. **Migration is reversible** — JSON export can restore to any point

---

## Open Questions

1. **Embedding-based retrieval**: Should we add vector embeddings for semantic search? This would require an embedding model (local or API). FTS5 keyword matching is good but misses semantic similarity. Could be a Phase 6 addition.

2. **Cross-agent memory sharing**: Should entities be shareable between agents? The JSON export/import enables this manually, but a shared registry could enable automatic knowledge sharing.

3. **Memory capacity limits**: Should there be a hard cap on entities? Or should the decay + hygiene system naturally keep the count manageable?

4. **LLM-supervised entity creation**: Should entity creation always go through an LLM for quality assessment? Or is that too expensive for high-frequency fact recording?

---

## Relationship to Guardian Network

The guardian network (implemented in commit 913b871) maintains whatever memory system exists. With SemanticMemory, the guardians evolve:

- **memory-hygiene** → Audits SemanticMemory entities instead of MEMORY.md text
- **session-continuity-check** → Verifies session digests are being created
- **degradation-digest** → Can track memory-related degradations
- **guardian-pulse** → Monitors memory migration job health

The guardians are the immune system. SemanticMemory is the nervous system. They complement, not replace, each other.
