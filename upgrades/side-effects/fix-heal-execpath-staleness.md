# Side-Effects Review — fix(heal): resilient process.execPath resolution

**Branch:** `echo/fix-heal-execpath-staleness`
**Origin:** Luna self-heal failure 2026-05-21 (topic 9976, "topic-intent-layer"). Justin's framing: "the deeper issue that needs to be fixed: why couldn't Luna self heal?"
**Scope guardrail:** sibling fix to the Topic Intent Layer work, not a fold-in. Heal-path only.

## Summary

When Homebrew updates Node mid-session, `process.execPath` becomes ENOENT. The native-module self-heal spawned subprocesses via that path, so the heal failed with `spawnSync … ENOENT` and the agent's SQLite-backed subsystems degraded. The fix resolves a stable Node binary through a fallback chain before spawning.

Two new files:
- `src/utils/resolveNodeBinary.ts` — TypeScript resolver used by `ensureSqliteBindings`.
- `scripts/resolve-node-binary.cjs` — CommonJS twin used by `fix-better-sqlite3.cjs`.

Two modified files:
- `src/commands/server.ts` — `ensureSqliteBindings` resolves the spawn target before invoking the rebuild path; emits DegradationReporter events on resolver-null and rebuild-failed paths.
- `scripts/fix-better-sqlite3.cjs` — Module-load resolution; every internal spawn uses the resolved `NODE_BIN`. `findNpmCli` resolves npm relative to the resolved Node, not raw `process.execPath`.

Two new test files:
- `tests/unit/resolveNodeBinary.test.ts` — 7 tests covering the fallback chain branch-by-branch.
- `tests/integration/heal-execpath-staleness.test.ts` — 6 tests reproducing the failure shape and verifying the fix.

## Over-block check

Does this fix do MORE than what was asked?

- The resolver does NOT change the once-per-process heal guard in `NativeModuleHealer`. That guard exists to prevent expensive rebuild loops and was deliberately left in place.
- The resolver does NOT bypass `verifyChildAbiMatches` in the fix script. The ABI-divergence defence is still in place — it now runs against a resolved Node binary instead of process.execPath, which is what makes the defence actually work in the failure mode we're fixing.
- The DegradationReporter events are NEW emissions but match the existing pattern (subsystem-init-failure events already use the same shape). They surface a previously-silent failure rather than introducing new noise.

## Under-block check

Does this fix leave the failure mode reachable through another path?

Other call sites that spawn via `process.execPath` were audited:
- `ServerSupervisor.preflightSelfHeal` — runs in the supervisor process, not the child server. Different process, different execPath lifecycle. Out of scope for this fix; supervisor process is short-lived and re-spawns on each cycle.
- `NativeModuleHealer.healBetterSqlite3Sync` — spawns `npmPath` (a separate variable resolved via `findNpmPath`) with `process.execPath` as args[0]. ENOENT on execPath here would also fail. **Follow-up:** apply the same resolver to this path in a separate small PR. Out of scope for this commit to keep the diff tight per the original ask.

The follow-up is tracked at the bottom of this artifact, not punted as an orphan TODO. (Per the `no-out-of-scope-trap` memory.)

## Level-of-abstraction fit

The resolver is a utility, not a subsystem. It does one thing: resolve a path. It's called from the existing heal-path call sites; it does not own any state, does not log autonomously, does not own the rebuild flow. The DegradationReporter emissions live in `ensureSqliteBindings`, not in the resolver — the resolver returns data, the caller decides whether to escalate.

This matches the signal-vs-authority pattern: the resolver is the signal layer (returns "here's a working Node, here's how I found it, or null if nothing works"); the caller is the authority that decides what to do with that signal.

## Signal-vs-authority compliance

The resolver emits no degradation events, no logs, no side effects beyond resolving a path. It returns a structured value or null.

The caller (`ensureSqliteBindings`) is the authority — it decides:
- Whether to proceed with the rebuild (only if resolver returned a path).
- Whether to emit a DegradationReporter event (yes when resolver returns null OR when rebuild fails after resolution).
- What recovery hint to surface in the degradation impact field.

Two emission sites, both with explicit recovery actions:
- `ensureSqliteBindings.nodeBinaryResolution` — fires when the resolver returns null. Recovery: reinstall Node and restart.
- `ensureSqliteBindings.rebuildFailed` — fires when rebuild fails after resolution. Recovery: restart agent OR run `npx instar update`.

## Interactions with other systems

- **NativeModuleHealer.openWithHeal** (the in-line heal path for direct constructor calls): NOT modified by this PR. That path still uses `process.execPath` internally. The follow-up applies the same resolver there.
- **ServerSupervisor.preflightSelfHeal**: NOT modified. Supervisor runs in a separate process with its own execPath lifecycle.
- **UpdateChecker.applyUpdate**: Already had its own rebuild path that worked on luna (visible in the server log at 02:35 and 03:21 — both successful rebuilds while the server kept running with stale bindings). No conflict: UpdateChecker's rebuilds happen in long-running processes that already hold the broken in-memory binding; they take effect on next restart. This fix ensures the next restart's preflight can actually run.
- **PostUpdateMigrator**: NOT touched. Migrator script propagation works as before; no agent-side script needs migration for this fix because both new files (.ts + .cjs) live in the instar package itself.

## Rollback cost

Single-commit revert removes the resolver, the import, the call-site change in `ensureSqliteBindings`, and the resolver-pinned spawns in `fix-better-sqlite3.cjs`. The behavior reverts to "heal fails when execPath is stale" — the failure mode we're fixing, not a new one. No data migration, no config changes, no agent-side script propagation required.

## Cross-framework portability (v1.0+)

The heal path is framework-agnostic — it operates on Node binaries, not on the agent runtime (Claude Code vs Codex). The resolver uses standard Node APIs (`fs`, `os`, `child_process`) with no framework-specific code paths. Verified by:
- Integration test passes under the test-running Node regardless of framework.
- The Codex CLI runtime spawns differently but uses the same Node-binary substrate, so the resolver applies equally there.

No `INSTAR_FRAMEWORK`-conditional code added; no framework-aware adapters needed for this fix.

## Telemetry / observability

Heal-attempt visibility before this PR: a single yellow log line on failure.
Heal-attempt visibility after this PR: that log line PLUS a DegradationReporter event with structured fields (feature, primary, fallback, reason, impact). The event surfaces through `GET /degradations` (existing route) and any subscribers to the degradation event channel (existing pattern).

When the resolver fires a non-execPath fallback, a `console.log(pc.dim(...))` line names which fallback fired and the resolved path. This is one extra log line per server startup that needed it; on healthy startups it doesn't fire.

## Follow-ups (tracked, not orphaned)

1. Apply `resolveStableNodeBinary` to `NativeModuleHealer.healBetterSqlite3Sync` so the in-line CLI-direct-construction heal path (CLI commands like `instar memory ...`, TokenLedger constructor, etc.) also benefits. Should be a small commit on a separate branch — the heal-path-fix scope intentionally excluded it to keep this diff tight.

2. Consider whether the once-per-process heal guard in `NativeModuleHealer` should distinguish "heal failed due to spawn-target ENOENT" (transient, retryable when operator restores Node) from "heal failed due to rebuild error" (durable, don't retry). The current guard treats both the same. Lower priority than (1).

Both items will be filed as initiatives so they don't drop. Not part of this commit.
