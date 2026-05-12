# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

In-line self-heal for `better-sqlite3` `NODE_MODULE_VERSION` mismatch (PROP-399). When the running Node major differs from the major that `better-sqlite3` was compiled against, every SQLite-backed memory subsystem (`SemanticMemory`, `TopicMemory`, `MemoryIndex`) used to throw at first `open()` and fall back to a degraded path — leaving the agent without conversation summaries, semantic search, knowledge graph, or feature-registry persistence until a human ran `npm rebuild better-sqlite3`. 1254 field reports clustered on this single failure mode (`cluster-degradation-semanticmemory-semanticmemory-init-failed-the-m`).

New `src/memory/NativeModuleHealer.ts` wraps the `await import('better-sqlite3')` inside each `open()` path. On `NODE_MODULE_VERSION` error: locate the install prefix via `require.resolve`, locate `npm` on PATH, run `npm rebuild better-sqlite3 --prefix <prefix>` synchronously (~30s), clear `require.cache` so the fresh native binding loads on retry, retry the import + construct once. Heal attempts persist to `<stateDir>/native-module-heals.jsonl` for `DegradationReporter` and health probes. Once-per-process guard prevents looped rebuilds. `process.execPath` is pinned as the node binary for the spawned `npm` so the rebuild targets the correct ABI even when PATH points elsewhere.

`SemanticMemory.open()`'s existing corruption-recovery branch (integrity check, quarantine, JSONL rebuild) is unchanged and runs after the healer returns. The two heal layers compose: ABI mismatch heals first (import-time), corruption-quarantine heals second (post-open).

Spec: `docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md` (this PR ships the narrowest in-line slice; the broader Remediator orchestrator is a separate phase). Convergence: `docs/specs/reports/self-healing-remediator-convergence.md`.

## What to Tell Your User

- **Memory keeps working through Node updates**: "When your laptop's Node version drifts after I was installed, my conversation memory and semantic search used to silently fall over until someone rebuilt the database driver by hand. I now notice the version mismatch the first time I open the database, rebuild the driver, and keep going. It takes about half a minute the first time per session — and only happens when the mismatch is real."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| In-line `better-sqlite3` ABI self-heal across `SemanticMemory` / `TopicMemory` / `MemoryIndex` | automatic on first `open()` after a Node-version drift |
| Heal observability | `<stateDir>/native-module-heals.jsonl` (one line per attempt; consumed by `DegradationReporter`) |

## Evidence

Live reproduction during the original PROP-399 development run (commit `e080ec64`, 2026-05-10): vitest hit a real ABI mismatch under Node v25.6.1 with `better-sqlite3` built against v22; the healer rebuilt + retried successfully in 520ms. On the current rebased branch:

- 12 `NativeModuleHealer` unit tests pass (detects `NODE_MODULE_VERSION` error variants; runs rebuild once per process; retries opener after rebuild; logs `HealEvent` with `success: true/false`; surfaces post-rebuild errors directly without swallowing them; falls back gracefully when npm is missing).
- 12 pre-existing `SemanticMemory` corruption-recovery tests still pass alongside the healer wiring — proving main's corruption-quarantine + JSONL-rebuild path is preserved unchanged.
- 359 memory-related tests pass total across `SemanticMemory`, `TopicMemory`, `MemoryIndex`, `EpisodicMemory`, evidence, privacy, migrator, and backfill modules.
- Full unit-suite run on the rebased branch: 17,983 passed, 10 failed; all 10 failures are pre-existing integration-route flakes (`assembler-context-routes` ETIMEDOUT and `projects-api` fixture race) and pass on a targeted re-run. None touch `src/memory/` or the healer.
