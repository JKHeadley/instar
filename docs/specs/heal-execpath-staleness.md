---
title: "Heal-path resilience to stale process.execPath (Homebrew mid-session updates)"
slug: "heal-execpath-staleness"
author: "echo"
review-convergence: "single-iteration"
review-iterations: 1
convergence-note: "Retrospective single-iteration convergence: the failure mode was diagnosed live on luna 2026-05-21 with concrete log evidence and a one-shot manual fix that confirmed the heal works when given a stable Node binary. The fix is mechanically narrow (resolver utility + two call-site updates), rollback cost is one revert, and the failure mode reverted-to is the same one we're fixing today (not a worse state). Lower-risk than the usual 5-iteration target is acceptable per the same standard applied to the Initiative Tracker spec (2026-04-18)."
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-21"
approval-note: "Approved via Telegram topic 9976 (topic-intent-layer) — 'Yes please' in response to: 'Want me to write this up as a bug spec and ship the fix through /instar-dev as a sibling task to the Topic Intent Layer work?' Approval scoped to fix candidates (a) + (d) from the audit thread: realpath + fallback resolution and degradation-reporter escalation."
---

# Heal-path resilience to stale process.execPath

## ELI16 version

When Homebrew updates Node while the instar server is running, the agent's running Node binary gets moved out from under it. The server itself keeps working — its open file is still in memory — but any new "spawn another Node process" call fails because the file on disk is gone. The agent's auto-repair tool was using that very mechanism, so when the SQLite knowledge-graph needed a rebuild, the repair couldn't even launch. The agent then ran with a broken memory stack for hours, sometimes days.

The fix is small: before spawning, try the obvious Node path first; if it's missing, try a list of stable fallback paths (the stable Homebrew symlink, the standard install locations, then `which node`). If none of those work, the agent now emits a clear "Node is missing, please reinstall" message instead of silently degrading.

## Problem

`ensureSqliteBindings` in `src/commands/server.ts` spawns the native-module rebuild via `execFileSync(process.execPath, [fixScript], ...)`. The fix script `scripts/fix-better-sqlite3.cjs` also spawns child Node processes via `process.execPath` for ABI verification, binary testing, and the source-build path.

When Homebrew (or any package manager) replaces Node mid-session, the previous Cellar directory is removed but the running process keeps an open file descriptor to the deleted binary. Subsequent `spawnSync(process.execPath, ...)` calls return ENOENT — the file is gone from the filesystem.

Result: the self-heal path fails. SemanticMemory, TopicMemory, FeatureRegistry, and the pending-relay queue all stay degraded across restarts, because every restart re-attempts the heal with the same stale execPath.

Concrete evidence (luna 2026-05-21 02:46:00 UTC):

```
[LOG]   better-sqlite3: native binding mismatch detected — auto-rebuilding for current Node.js version...
[LOG]   better-sqlite3: rebuild failed (spawnSync /opt/homebrew/Cellar/node/25.6.1/bin/node ENOENT). SQLite subsystems may degrade.
[WARN] [DEGRADATION] SemanticMemory: SemanticMemory init failed: NODE_MODULE_VERSION 127 ≠ 141
[WARN] [DEGRADATION] TopicMemory: TopicMemory init failed: spawnSync ENOENT
[WARN] [DEGRADATION] FeatureRegistry: FeatureRegistry open failed: NODE_MODULE_VERSION 127 ≠ 141
[WARN] [DEGRADATION] sqlite-runtime-broken: better-sqlite3 failed to open an in-memory DB
```

8 degradations on a single agent, all rooted in one stale path.

## Solution

Three layers, all backed by the existing PROP-399 self-heal architecture.

### Layer 1 — Resolver utility

New file `src/utils/resolveNodeBinary.ts` with CommonJS twin at `scripts/resolve-node-binary.cjs`. Both implement the same fallback chain:

1. `process.execPath` (cheapest, almost always correct)
2. `fs.realpathSync(process.execPath)` if execPath itself is gone but its symlink target survives
3. Optional caller-supplied bundled agent Node (e.g., `<stateDir>/bin/node`)
4. Platform-stable absolute paths in order: `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`
5. `which node` from PATH as the final fallback

Returns the first existing-and-executable path with a `source` tag indicating which fallback fired (useful for logs). Returns `null` only when every candidate fails — fail-closed by design.

### Layer 2 — `ensureSqliteBindings` resolves before spawning

`src/commands/server.ts` calls `resolveStableNodeBinary()` before invoking either the bundled fix script or the npm-rebuild fallback. If the resolver returns null, a structured `DegradationReporter.report` event fires with an explicit recovery hint (reinstall Node + restart agent).

When rebuild itself still fails after resolution, a second `DegradationReporter.report` event fires (feature: `ensureSqliteBindings.rebuildFailed`) with the underlying error and a user-actionable next step. The previously-silent yellow log line stays for backward compat, but the structured event surfaces through `GET /degradations` and any subscribers to the existing channel.

### Layer 3 — `fix-better-sqlite3.cjs` uses the resolver throughout

The script resolves once at module load into a constant `NODE_BIN` and uses that for:

- `testBinary` — exercising the rebuilt `.node` binary against an in-memory DB
- `verifyChildAbiMatches` — the ABI defence step from PROP-399 / Inspec 2026-04-21
- `trySourceBuild` — the npm-rebuild source-from-source fallback
- `findNpmCli` — the npm sibling lookup (must use NODE_BIN's dirname, not execPath's, so a stale execPath doesn't poison npm discovery)

A console.warn at the top names which fallback fired if NODE_BIN ≠ execPath. The behaviour in the healthy case is identical to the pre-fix code (resolver's first preference IS execPath).

## Decision-point inventory

1. **Fail-closed vs fail-open when resolver returns null.** Default: fail-closed (emit degradation, do not proceed). Alternative: try the rebuild anyway against execPath and let it ENOENT noisily. Chose fail-closed because the alternative is what we're fixing — silent failure with no actionable signal.

2. **Touch the once-per-process heal guard in `NativeModuleHealer`.** Default: no. The guard exists to prevent expensive rebuild loops. The stale-execPath failure mode is transient-but-not-this-process — once the binary is restored, a fresh server start picks it up. Re-attempting within the same dead process won't help.

3. **Apply the resolver to `NativeModuleHealer.healBetterSqlite3Sync` (the in-line CLI-direct-construction path).** Default: no, deferred. That path is exercised by direct CLI invocations of `instar memory ...`, `TokenLedger`, etc. — different failure-surface than the server startup we're fixing. Tracked as a follow-up to keep this diff tight.

4. **Cross-framework portability (v1.0+).** The heal path is framework-agnostic — it spawns Node binaries, not framework runtimes. Resolver uses only standard `fs`, `os`, `child_process` APIs. No `INSTAR_FRAMEWORK`-conditional code needed.

## Tests

Unit (`tests/unit/resolveNodeBinary.test.ts`): 7 tests covering each branch of the fallback chain — execPath OK, execPath ENOENT + bundled, execPath ENOENT + Homebrew, all-fail-PATH-works, total fail, non-executable file rejection, realpath fallback.

Integration (`tests/integration/heal-execpath-staleness.test.ts`): 6 tests reproducing the luna failure shape and verifying recovery. Notably (a) confirms `spawnSync` against a stale Cellar path returns ENOENT (the exact log line from luna) and (b) confirms a child process spawned against the resolved fallback path actually executes.

Updated (`tests/unit/fix-better-sqlite3-state.test.ts`): 3 existing source-level assertions changed from `process\.execPath` to `NODE_BIN`. The original safety intent (no `node` from PATH) is preserved — the resolver's first preference is still execPath; only when ENOENT do we fall through.

## Acceptance evidence

Per the `bug-fix-evidence-bar` memory, a fix is not shipped until the original failure is reproduced and verified to stop.

**Reproduction**: `tests/integration/heal-execpath-staleness.test.ts:38-43`:

```ts
const result = spawnSync(STALE_CELLAR, ['--version'], { encoding: 'utf-8' });
expect(result.error).toBeDefined();
expect((result.error as NodeJS.ErrnoException).code).toBe('ENOENT');
```

This is the exact log shape from luna 2026-05-21 02:46:01.119Z.

**Verified to stop**:

```ts
const resolved = resolveStableNodeBinary({
  execPathOverride: STALE_CELLAR,
  agentBundledNode: process.execPath,
});
expect(resolved).not.toBeNull();
expect(resolved!.source).not.toBe('execPath');
const probe = spawnSync(resolved!.path, ['-e', 'process.exit(0)']);
expect(probe.status).toBe(0);
```

The resolver returns a working fallback; spawning against it succeeds.

**Live confirmation**: manually invoking `fix-better-sqlite3.cjs` via the resolved Node binary on luna brought her degradation count from 8 to 1, with SemanticMemory (42 entities migrated post-rebuild), TopicMemory, FeatureRegistry, and the pending-relay queue all returning to healthy.

## Rollback

Single-commit revert removes the resolver and the call-site changes. Reverts to the pre-fix failure mode (heal fails when execPath is stale) — not a worse state. No data migration, no config changes.

## Out of scope (intentional)

- `NativeModuleHealer.healBetterSqlite3Sync` resolver wiring (tracked as a follow-up initiative).
- Transient-vs-durable distinction in the once-per-process heal guard (lower priority).
- Supervisor-side preflight heal in `ServerSupervisor.preflightSelfHeal` (different process lifecycle).

## Origin

Topic 9976 (topic-intent-layer), 2026-05-21. Justin's question after the Phase 0 investigation: "Also, the deeper issue that needs to be fixed: why couldn't Luna self heal?" The investigation surfaced the stale-execPath failure mode in luna's server log and confirmed it by manually invoking the heal via the resolved Node — which worked. This spec captures the structural fix.
