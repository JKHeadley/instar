---
kind: "spec"
id: "intelligent-working-set-lazy-sync"
title: "Intelligent Working-Set Lazy-Sync"
summary: "Need-driven, per-topic working-set sync: the files the user created/edited on one machine are available on the next machine without manual re-download."
---

# Intelligent Working-Set Lazy-Sync

**Status:** DRAFT
**Owner:** Echo  
**Created:** 2026-07-03  
**Goal Alignment:** Goal B (Seamless agent across machines)

## Problem

When a conversation moves between machines, **artifacts created on Machine A are not on Machine B**:
- User creates a spec on Laptop → conversation moves to Mini → the spec is not on Mini
- Operator asks "where's the report I generated 20 minutes ago?" → "It's on the other machine"
- Working-set sync (pull files between machines) exists but is **manual + operator-initiated**

Goal B requires this to be **automatic and transparent**: files follow the conversation.

## Design

### Core Concept: Per-Topic Artifact Registry

Each topic carries a durable **artifact manifest** listing every file the agent created/modified in that conversation:
- Path (e.g., `docs/specs/foo.md`)
- Machine that holds it (where it was created)
- Hash (content fingerprint for change detection)
- Timestamp (when it was written)

### Layer 1: Registry Recording

Every Write/Edit tool call in a topic:
1. Records the artifact path + hash to the topic's manifest
2. Tags the manifest with the calling machine's identity
3. Persists the manifest durably (in topic state, not in-memory)

### Layer 2: Cross-Machine Fetch on Demand

When a topic moves to a different machine (via topic-swap or manual transfer):

```
Machine A (Laptop):  topic #123 owns /docs/foo.md, /src/bar.ts
    ↓ (topic-swap to Mini)
Machine B (Mini):    topic #123 resumes
    ↓ (at session-start or first need)
Fetch: POST /coherence/fetch-working-set { topic: 123 }
    ↓
Result: /docs/foo.md, /src/bar.ts synced to Mini via SecureCache
```

The fetch:
- Lists the manifest
- For each artifact, fetches from the producer machine via 1MB slices (resumable)
- Verifies hash on arrival
- Writes to the same path on the new machine
- Never overwrites (names divergent local copies alongside)

### Layer 3: Lazy Loading in Conversation Context

When the session starts on a new machine, the first LLM turn **mentions** the working-set status:

```
# Working-Set Status (implicit to you, not shown to user)
Synced from Laptop 90 seconds ago: docs/specs/foo.md, src/bar.ts (34KB total)
Divergent local copy: docs/specs/foo.md.local (from previous work)
Not yet synced: [none]
```

This grounds the agent: it knows which files are current, which are stale, which exist locally but not remotely.

### Layer 4: Collision Handling

If a file was created on BOTH machines (offline period):
- Fetch renames the incoming version: `foo.md.from-laptop`
- Local version stays at `foo.md`
- Session context flags the divergence
- User (or orchestrator) decides which version to keep

## Implementation Strategy

### Phase 1: Artifact Registry + Recording
- Add `artifacts: [{ path, hash, createdAt, machineName }]` to topic state
- Write/Edit tools append to registry on success
- Registry persists atomically (no partial writes)

### Phase 2: Fetch-Working-Set Enhancement
- Already exists; enhance to read artifact registry
- For each artifact, fetch via 1MB slices + hash verify
- Handle divergent names + missing files
- Return fetch report: `{ synced, divergent, notFound, totalBytes }`

### Phase 3: Session-Start Grounding
- At session boot, read the artifact manifest
- Inject implicit working-set context (never visible to user)
- Agent knows what files are current vs. stale

### Phase 4: Integration with Topic-Swap
- Before completing a topic-swap, trigger fetch-working-set automatically
- Swap completes only after working-set is synced (or operator overrides with `--no-sync`)
- User sees: "Moving to <machine>... syncing files... done."

### Phase 5: Garbage Collection
- Artifacts older than 30 days (or operator-configured TTL) are purged from the manifest
- Prevents unbounded manifest growth on long-running conversations

## Test Plan

**Tier 1 (Unit):**
- Artifact registry serialization/deserialization
- Hash collision detection
- Divergent-name generation

**Tier 2 (Integration):**
- Write/Edit tools correctly append to registry
- Fetch-working-set reads registry and fetches files
- Divergent files renamed correctly

**Tier 3 (E2E):**
- Create a spec on Laptop in topic #ABC
- Move topic #ABC to Mini
- Verify spec exists on Mini with same content
- Modify spec on Mini, verify hash changed
- Move topic back to Laptop, verify both versions exist + conflict flagged

## Success Criteria

- [ ] Every artifact created/edited in a topic is recorded in the manifest
- [ ] Topic swap triggers automatic working-set fetch
- [ ] Files follow the conversation transparently (user doesn't ask for it)
- [ ] Divergent edits detected + handled gracefully
- [ ] Session context mentions working-set status (for agent grounding)
- [ ] Live-verified on real pair with real edits

## Scope Notes

- **Paths:** Only user-visible work in the project (docs/, src/, tests/). Not node_modules/ or .git/ internals.
- **Excluded:** Temporary files, cache dirs, lock files (these sync via other mechanisms)
- **Size limit:** Individual artifacts capped at 50MB (resumable fetch handles large files)

---

**Related specs:** llm-seamlessness-orchestrator, mesh-self-heal-graduation
