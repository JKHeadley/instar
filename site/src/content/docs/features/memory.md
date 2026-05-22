---
title: Conversational Memory
description: Per-topic SQLite memory with full-text search and rolling summaries.
---

Every conversation is stored, searchable, and summarized -- so the agent picks up exactly where it left off.

## Architecture

Messages are dual-written to two stores:

- **JSONL** (source of truth) -- Append-only log of all messages
- **SQLite** (query engine) -- FTS5 full-text search index, derived from JSONL

The SQLite index can be deleted and rebuilt anytime from the JSONL source.

## Rolling Summaries

LLM-generated conversation summaries update incrementally as conversations grow. These summaries are injected as highest-priority context on session start and after compaction.

This means the agent never starts cold -- it always has the context of what was discussed before.

## Full-Text Search

Search across all agent knowledge:

```bash
# CLI
instar memory search "deployment strategy"

# API
curl "localhost:4040/memory/search?q=deployment+strategy"
```

Search covers AGENT.md, USER.md, MEMORY.md, relationships, and conversation history.

## Semantic search (vector embeddings)

In addition to FTS5 keyword search, instar supports semantic search via vector embeddings using the `sqlite-vec` extension. Semantic search finds conceptually-related content even when the exact words don't match — searching for "deployment strategy" turns up entries about "rollout plans" and "shipping cadence" too.

```bash
# Semantic search via CLI
instar semantic search "rollout strategy"

# Specific semantic API operations
curl "localhost:4040/semantic/recall?q=...&limit=10"
curl -X POST localhost:4040/semantic/remember -d '{"text": "..."}'
curl -X POST localhost:4040/semantic/connect -d '{"from": "id1", "to": "id2"}'
```

The embedding provider is pluggable. Built-in providers cover OpenAI, Anthropic, and local model backends. Configure via the `embedding` block in `.instar/config.json`.

### FTS5-only graceful fallback

If the `sqlite-vec` extension isn't available on your host (it ships as a native binary that not every platform has prebuilds for), semantic search falls back to FTS5 transparently. You won't see vector-style results, but you also won't see an error — keyword search keeps working. Verify which mode is active:

```bash
curl localhost:4040/memory/status
```

## Working memory assembly

Components: `WorkingMemoryAssembler`, `MemoryIndex`, `Chunker`, `EvidenceRenderer`.

The agent's session context isn't loaded wholesale from disk. The working memory assembler picks what's relevant for the current turn — recent messages, salient memories, evidence rows from the decision journal, identity files — and assembles them into the prompt context. The chunker handles long source documents by splitting them into searchable units while preserving boundaries. The evidence renderer formats memory entries with provenance citations so the agent can ground claims in specific past observations rather than fuzzy recall.

This is the subsystem responsible for "the agent remembers exactly what you discussed three weeks ago when it's relevant." It runs invisibly on every session start and after every compaction.

## Topic Context

```bash
# Get summary + recent messages for a topic
curl localhost:4040/topic/context/TOPIC_ID

# List all topic summaries
curl localhost:4040/topic/summary

# Trigger summary regeneration
curl -X POST localhost:4040/topic/summarize
```

## Index Management

```bash
instar memory reindex   # Rebuild the search index
instar memory status    # Index stats
```
