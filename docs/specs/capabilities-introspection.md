---
slug: capabilities-introspection
title: Move /capabilities and its discoverability lint to a single registry — src/server/CapabilityIndex.ts
review-convergence: 2026-05-21T16:30:00Z
approved: true
eli16-overview: capabilities-introspection.eli16.md
---

# Capabilities Introspection

## Problem

PR #290 added a structural lint that walks `src/server/routes.ts` for every top-level route prefix and asserts each is either surfaced in the `/capabilities` response body or on an explicit `INTERNAL_ALLOWLIST`. The lint closed the original gap (Secret Drop slipping through silently) but introduced a second one: now there are **two** hand-maintained surfaces of capability policy.

1. **The /capabilities handler** in `routes.ts` — a 440-line object literal with inline build logic per block (telegram, secrets, commitments, ...).
2. **The lint's `INTERNAL_ALLOWLIST`** — a 50-entry list in test code with one-line reasons next to each entry.

Both have to stay in sync. Nothing structurally connects them. The case study (topic 11141, 2026-05-21) named this as the next obvious risk: with two hand-curated surfaces, the next primitive will eventually appear in one but not the other, and the lint will silently rubber-stamp the inconsistency because both the source and the policy live in the same human's head.

## Approach

Extract `src/server/CapabilityIndex.ts` as the single source of truth.

The module exports:

- `CAPABILITY_INDEX: readonly CapabilityEntry[]` — one entry per capability. Each entry has `{ key, prefixes, description, build(input) }`. The `build` function takes a typed `CapabilityBuildInput` (the route context, scripts list, and SecretDrop reference) and returns the response block.
- `INTERNAL_PREFIXES: readonly { prefix, reason }[]` — operator-only routes that should NOT appear in /capabilities, each with a one-line reason.
- `buildAllCapabilityBlocks(input)` — iterates `CAPABILITY_INDEX` and returns the merged response blocks. The /capabilities handler calls this and spreads the result.
- `buildPrefixToKeyMap()` / `buildInternalPrefixSet()` — helpers the lint uses to classify each top-level prefix in routes.ts.

The /capabilities handler in routes.ts shrinks to ~25 lines: gather identity files + scripts + hooks lists (those stay handler-local because they require fs reads against the agent's own dirs), then `res.json({ ...header, ...buildAllCapabilityBlocks({ ctx, scripts, secretDrop }) })`.

The lint in `tests/unit/capabilities-discoverability.test.ts` is rewritten to use the imported helpers. The old hand-written `INTERNAL_ALLOWLIST` is deleted from test code. The lint now enforces three invariants:

1. Every top-level prefix in routes.ts is either claimed by `CAPABILITY_INDEX` or listed in `INTERNAL_PREFIXES`.
2. No prefix appears in both.
3. No entry in `CAPABILITY_INDEX` or `INTERNAL_PREFIXES` is orphaned (every declared prefix maps to an actual route).

A second test file, `tests/unit/CapabilityIndex.test.ts`, pins module-level invariants: unique keys, unique prefixes, non-empty descriptions, non-empty internal-prefix reasons, and a regression guard that the `secrets` entry continues to surface the hardened-retrieval hint.

## Non-goals

- Derive `CAPABILITY_INDEX` from the live Express router at runtime. The router doesn't carry semantic intent (which routes are operator-only vs agent-facing), so a runtime walk wouldn't replace the classification step. The static registry is the right shape.
- Merge `CAPABILITY_INDEX` with `FeatureRegistry.BUILTIN_FEATURES`. They serve different audiences: BUILTIN_FEATURES is opt-in features with consent flows; CAPABILITY_INDEX is the always-on primitive surface. The discovery block in /capabilities continues to expose the FeatureRegistry summary (under `key: 'discovery'`).
- Change the /capabilities response shape. Every key that appeared before still appears; field names + nesting are identical. This is a pure refactor.

## Acceptance criteria

- `src/server/CapabilityIndex.ts` exists. `CAPABILITY_INDEX` has at least the 30 known-good entries (telegram, imessage, scheduler, ..., discovery). `INTERNAL_PREFIXES` has at least the legacy / operator-only prefixes.
- `routes.ts` /capabilities handler is reduced to ~25 lines that delegate to `buildAllCapabilityBlocks`.
- `tests/unit/capabilities-discoverability.test.ts` no longer carries an inline allowlist; it imports from `CapabilityIndex.ts` and enforces the three invariants above.
- `tests/unit/CapabilityIndex.test.ts` exists and pins 9 module-level invariants.
- Existing integration tests that exercise /capabilities (publishing-routes, view-tunnel-routes, external-operation-safety-routes, imessage-routes) pass unchanged.
- `npx tsc --noEmit` clean.

## Decision points touched

- The /capabilities response builder — **modify (refactor only)** — same output, different production path.
- The discoverability lint — **modify** — same invariant, different source of truth.

No new gate/block authority introduced. The lint is signal-only (CI fails on classification gap; no runtime block).

## Migration

- Hooks: no change.
- Settings: no change.
- Config defaults: no change.
- CLAUDE.md sections: no change. The Self-Discovery section continues to instruct `curl /capabilities`; the response remains shape-identical.
- Hook scripts: no change.
- Built-in skills: no change.
- No agent-side migration needed. Agents will see byte-for-byte the same response (modulo iteration order in JS objects, which is insertion-ordered per spec).

## Rollback

Pure code change. Revert the three new files (CapabilityIndex.ts, CapabilityIndex.test.ts, the spec/artifact docs) and the routes.ts diff. The lint test reverts to its prior body. No persistent state.

## Origin

2026-05-21 case-study audit (topic 11141, follow-up #2 of two). Follow-up #1 (PR #292) closed the workaround-reflex side by retiring the unsafe Secret Drop retrieval pattern. This spec closes the discoverability story by collapsing the two hand-curated surfaces into one.
