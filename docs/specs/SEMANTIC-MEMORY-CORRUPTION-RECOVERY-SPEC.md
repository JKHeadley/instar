---
title: "SemanticMemory Corruption Detection and Auto-Recovery"
slug: "semantic-memory-corruption-recovery"
author: "gfrankgva"
status: "converged"
review-convergence: "2026-04-27T18:00:00Z"
review-iterations: 3
review-completed-at: "2026-04-27T18:00:00Z"
approved: true
approved-by: "JKHeadley"
approved-date: "2026-04-13"
approval-note: "Approved in PR #40 review — JKHeadley said 'Happy to land this as-is' with two non-blocking suggestions (quarantine + marker), both addressed."
---

# SemanticMemory Corruption Detection and Auto-Recovery

## Problem

`TopicMemory.open()` already has corruption detection with auto-rebuild from its JSONL append log. `SemanticMemory.open()` had no such protection — if `semantic.db` corrupts (disk error, unclean shutdown, etc.), the entire knowledge graph is permanently lost despite the JSONL source-of-truth being intact.

## Solution

Mirror TopicMemory's resilience pattern in SemanticMemory:

1. Run `PRAGMA integrity_check` after opening the DB
2. If corruption is detected, quarantine the corrupt DB (rename to `.corrupt.<timestamp>`) and write a JSON marker file for operator visibility
3. Open a fresh DB and auto-rebuild from the JSONL append log
4. Size-gate the rebuild: if JSONL exceeds `autoRebuildMaxBytes` (default 50 MB), skip synchronous rebuild and log a warning — operator rebuilds manually

## Decision Points

- **Quarantine over delete**: corrupt bytes survive for forensic analysis (WAL tear? disk full?). Rename-with-fallback-to-delete ensures startup never blocks on corruption recovery.
- **Marker files over event bus**: instar has no centralized event bus. Marker files (`.corrupt-recovery.<ts>.marker.json`) are scannable by monitoring without log tailing and survive process restarts.
- **Synchronous rebuild with size gate**: async rebuild would leave memory empty during session-start hooks. Size gate (configurable `autoRebuildMaxBytes`) protects against blocking startup on very large graphs while keeping the common case (< 50 MB) fully automatic.
- **Corruption detection only at open()**: mid-session disk errors surface through SQLite's own error handling on individual queries. Full integrity scans are expensive and belong in the startup path, not the hot path.

## Files Changed

- `src/core/types.ts` — Add optional `autoRebuildMaxBytes` to `SemanticMemoryConfig`
- `src/memory/SemanticMemory.ts` — Add `quarantineCorruptDb()`, integrity check in `open()`, size-gated rebuild
- `tests/unit/semantic-memory-corruption-recovery.test.ts` — 11 contract tests covering all recovery paths

## Refinement (2026-05-23): probe must not misread a missing extension as corruption

The secondary probe-read MUST distinguish disk corruption from an unavailable
loadable extension. The probe runs before `initVectorSearch()` loads sqlite-vec, so
`SELECT * FROM entity_embeddings` (a vec0 *virtual* table) throws
`no such module: vec0` — which is an extension-availability signal, never page
corruption. Misclassifying it caused a quarantine + rebuild on every boot.

Contract additions:
- The probe excludes virtual tables (`sql NOT LIKE 'CREATE VIRTUAL TABLE%'`). Vector
  data lives in vec0 *shadow* tables (plain tables), which remain probed, so
  embedding-storage corruption is still detected.
- Any `no such module` error during the probe is treated as a missing loadable
  extension (skip + warn once, continue FTS5-only), never corruption.
- Failure to read `sqlite_master` itself remains genuine corruption.

Tests: `tests/unit/semantic-memory-vec0-probe.test.ts`.
