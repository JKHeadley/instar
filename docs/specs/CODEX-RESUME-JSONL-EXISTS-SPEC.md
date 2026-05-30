---
title: jsonlExists resolves codex rollout files so resume works for codex agents
review-convergence: retrospective-single-pass
approved: true
eli16-overview: CODEX-RESUME-JSONL-EXISTS.eli16.md
---

# jsonlExists Resolves Codex Rollout Files

## Problem

`ThreadResumeMap.jsonlExists` and `TopicResumeMap.jsonlExists` are the guards
that decide whether a saved session UUID still has a transcript on disk before
the resume maps return it from `get()`. Both check ONLY the Claude flat layout —
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.

A codex agent never writes there. Codex writes date-partitioned rollout files:
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. So for every codex
session, `jsonlExists` returns `false`, the resume entry is treated as
expired/missing, `get()` returns `null`, and the ~9 consumers that depend on it
(ThreadlineRouter resume, ThreadlineMCPServer, TopicLinkageHandler, the
server-side topic resume path) all silently fail to resume. Resume is broken
fleet-wide for codex agents.

## Scope

Make both `jsonlExists` predicates framework-aware by adding a codex rollout
fallback, reusing the existing codex session-path helpers.

In scope:

- `src/providers/adapters/openai-codex/observability/sessionPaths.ts` — add
  `findRolloutFileSync(threadId, codexHome?)`, a synchronous sibling of the
  existing async `findRolloutFile` (the resume-map guards are synchronous and
  cannot await).
- `src/threadline/ThreadResumeMap.ts` — `jsonlExists` checks the Claude layout
  first (unchanged), then falls back to `findRolloutFileSync`.
- `src/core/TopicResumeMap.ts` — same fallback in its `jsonlExists`.

Out of scope: the other claude-first assumptions surfaced in the same audit
(RateLimitSentinel / CompactionSentinel default JSONL roots, the silence
sentinel's codex activity signals) — tracked separately.

## Design

`findRolloutFileSync` mirrors the async `findRolloutFile` exactly — a recursive
filesystem walk of `$CODEX_HOME/sessions` for a file matching
`rollout-*-<uuid>.jsonl` — using the synchronous `readdirSync`/`statSync`. A
missing `$CODEX_HOME/sessions` (the common case for a pure Claude agent) returns
`null` immediately because `readdirSync` throws and is caught.

Each `jsonlExists` keeps its existing Claude check unchanged and returns early on
a Claude hit, so Claude behavior is byte-for-byte unchanged. Only when the Claude
layout has no match does it consult the codex layout. Both checks are wrapped so
a filesystem error in one layout falls through to the other rather than throwing.

Reuse rationale: `findRolloutFile` / `codexHomeFromConfig` are the same helpers
`TokenLedger` already uses to attribute codex token usage — this is the
established codex-awareness seam, not a new one.

## Testing

- **Unit** (`tests/unit/codexRolloutFileSync.test.ts`):
  - `findRolloutFileSync` — both sides of the boundary: present rollout (any date
    partition) → path; no matching uuid → null; missing `$CODEX_HOME/sessions` →
    null; empty uuid → null; a non-rollout file containing the uuid → null.
  - `TopicResumeMap.jsonlExists` (via the existing `jsonlExistsPublic` hook, with
    `$HOME` pointed at a fixture) — a codex session with only a rollout file (no
    Claude jsonl) now returns `true`; an absent uuid returns `false`. This is the
    exact fix boundary: it was `false` before.
- **Regression**: the full resume-map suite (ThreadResumeMap, TopicResumeMap,
  topic-resume-map, resume-failed-uuid-gate, session-resume-e2e — 133 tests)
  stays green, confirming the Claude path is unchanged.

## Risks and non-goals

- `jsonlExists` now does a codex-tree walk when the Claude layout misses. For a
  Claude-only agent there is no `$CODEX_HOME/sessions`, so the walk is a single
  failed `readdirSync` — negligible. For a codex agent the walk is bounded by the
  session count; this is the same cost the async path already pays per resume.
- Claude is checked first, so a codex agent pays a small redundant Claude-dir
  read before the codex hit. Acceptable — keeping the order framework-agnostic
  avoids threading framework state into the predicate.
- This fixes the resume predicate only. Other claude-first assumptions are out of
  scope and tracked separately.
