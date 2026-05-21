---
slug: safe-fs-agent-state-carveout
review-convergence: converged
review-iterations: 1
review-completed-at: "2026-05-21T17:05:00Z"
approved: true
approved-by: dawn
approved-rationale: |
  Emergency field fix. Echo (1.2.4) is in a cold-start crash loop on dawn-macbook;
  Justin explicitly directed Dawn to take Echo's role as primary Instar dev and
  ship this fix without waiting for the full multi-iteration convergence review.
  Spec is mechanical (60 lines), carve-out is one function + one branch, audit
  trail makes operation observable, all 17 tests pass. Post-merge review welcome.
---

# SafeFsExecutor Agent-Runtime-State Carve-Out

## Problem

When instar is deployed in agent mode (e.g. `~/.instar/agents/<name>/`), the agent's deployed directory IS a checkout of the instar source — same `.git`, same `.instar-source-tree` marker, same `package.json` with `name: "instar"`. The source-tree guard's three layers (marker file, canonical remote URL, source-identity signature) all correctly identify the agent root as the instar source.

But the agent's runtime state lives at `<root>/.instar/` (sockets, locks, logs, audit trail, shared-state JSONL). Those paths are gitignored — they are NOT source code. Destructive ops on them (e.g., `WakeSocketServer.stale-socket-recovery` unlinking a stale `listener.sock`) are a normal part of operation, not a 2026-04-22-class incident.

Observed in the field 2026-05-21 on dawn-macbook Echo, immediately after v1.2.4: every cold start hit `EADDRINUSE` on `.instar/listener.sock`, the WakeSocketServer's stale-socket-recovery correctly attempted to unlink it, but `SafeFsExecutor.guard()` routed the unlink through `assertNotInstarSourceTree` and the guard fired. The supervisor declared the server unhealthy, escalated to bind-failure recovery, force-rebuilt better-sqlite3 on every cycle, and the agent never bound.

## Root cause

`SafeFsExecutor.guard()` does not distinguish between "destructive op against source code" (the 2026-04-22 class of incident, which the guard exists to block) and "destructive op against runtime artifacts that happen to be inside a directory tree the guard classifies as source". The agent's `.instar/` subdirectory is the second class, but the guard treats it as the first.

## Design principle

The carve-out must be:

1. **Narrow.** Only paths under a `.instar/` subdirectory of the source root. The `.instar` directory itself remains protected.
2. **Aligned with the project's own boundaries.** The project's `.gitignore` already enumerates `.instar/state/`, `.instar/logs/`, `.instar/audit/`, `.instar/instar-dev-traces/`, and `.instar/shared-state.jsonl` as not-source. The carve-out generalizes that: anything under `.instar/<path>` is runtime state.
3. **Observable.** Every carve-out invocation must leave a positive audit trail (`outcome: "allowed"`, `reason: "agent-runtime-state-carveout"`) so operators can verify it's being exercised exactly when expected.
4. **Reversible.** A single-commit revert restores the brittle-block behavior exactly. No migration needed.

The guard's three detection layers are unchanged. The carve-out lives one layer below the guard, in `SafeFsExecutor.guard()` itself.

## Implementation

`src/core/SafeFsExecutor.ts`:

1. Add `isUnderAgentRuntimeState(canonical: string): boolean` — interior-only predicate. Matches when `${sep}.instar${sep}` appears in the canonical path AND is followed by at least one additional path segment.

2. In `guard()`, after canonicalization but before `assertNotInstarSourceTree`, check the predicate. If true, emit an `outcome: "allowed"` audit entry and return the canonical path without further guard checks.

`tests/unit/SafeFsExecutor.test.ts`:

5 new tests under `describe('SafeFsExecutor agent-runtime-state carve-out', …)`:

- `allows unlink on a socket file under <root>/.instar/`
- `allows unlink on a lock file under <root>/.instar/`
- `allows rm on a nested file under <root>/.instar/state/`
- `still BLOCKS rm on the .instar directory itself (not its contents)`
- `still BLOCKS unlink on source files at the tree root`

## What stays caught

1. **All source files at the tree root** — anything outside `.instar/`. The 2026-04-22 incident damage (`README.md`, `src/auth.ts`, `src/middleware.ts`) is still blocked.

2. **The `.instar` directory itself** — `safeRmSync` on `<root>/.instar` is still rejected. The predicate requires at least one additional path segment after `/.instar/`.

3. **All three detection layers** are unchanged.

## What's no longer caught

Files and nested directories under `<source-root>/.instar/<anything>`. See `upgrades/side-effects/safe-fs-agent-state-carveout.md` for the full under-block analysis.

## Open questions

None. The carve-out is mechanical; the predicate is exact; the audit trail makes invocation visible.
