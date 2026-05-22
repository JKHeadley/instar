# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**fix(heal): better-sqlite3 self-heal now survives Homebrew Node updates that strand process.execPath.**

When Homebrew (or any package manager) updates Node while an instar server is running, the brew install swaps the `/opt/homebrew/bin/node` symlink and removes the previous Cellar directory. The server process keeps an open file descriptor to the deleted binary, so it continues executing — but any new `spawnSync(process.execPath, ...)` call returns ENOENT. The native-module self-heal path runs through exactly that kind of spawn, so the heal silently fails. The agent then degrades to legacy-memory fallbacks and stays there across restarts (the next startup hits the same stale execPath).

This was observed live on luna 2026-05-21. Server log showed the heal firing at 02:46:00, then 150ms later: `"rebuild failed (spawnSync /opt/homebrew/Cellar/node/25.6.1/bin/node ENOENT). SQLite subsystems may degrade."` Knowledge graph, conversation summaries, and the pending-relay queue all went offline while a healthy Node (a different Cellar version) was sitting on disk a few millimetres away.

The fix:

1. New `resolveStableNodeBinary()` helper at `src/utils/resolveNodeBinary.ts` (with a CommonJS twin at `scripts/resolve-node-binary.cjs`). It walks a fallback chain — `process.execPath` → `fs.realpathSync(execPath)` → optional caller-supplied bundled Node → `/opt/homebrew/bin/node` (the stable symlink Homebrew always maintains) → `/usr/local/bin/node` → `/usr/bin/node` → `which node` — and returns the first existing-and-executable path, or null when every candidate fails.

2. `ensureSqliteBindings()` in `src/commands/server.ts` now resolves the spawn target through `resolveStableNodeBinary()` before invoking either the bundled `fix-better-sqlite3.cjs` or the npm-rebuild fallback. If resolution returns null, a structured DegradationReporter event is emitted with an explicit recovery hint instead of the previous "rebuild failed (ENOENT)" log line.

3. `scripts/fix-better-sqlite3.cjs` resolves once at module load and uses the resolved path for every internal spawn (testBinary probe, verifyChildAbiMatches defence, source-build via npm). `findNpmCli` also resolves the npm sibling relative to the resolved Node so a stale execPath doesn't poison npm discovery.

4. When the rebuild itself still fails after resolution, `ensureSqliteBindings()` emits a second DegradationReporter event (`ensureSqliteBindings.rebuildFailed`) with a user-actionable recovery hint. Previously the failure was a single yellow log line; now it surfaces through the same degradation channel operators already monitor.

Fail-closed semantics preserved: if no Node binary is reachable anywhere, the heal does NOT proceed (the alternative — guessing wrong — risks producing an ABI-mismatched binary that fails silently later). The DegradationReporter event names the missing Node so the operator can fix it.

## Evidence

Failure mode reproduced and verified to stop:

Reproduction (`tests/integration/heal-execpath-staleness.test.ts`) covers six scenarios drawn directly from the luna incident:

1. `spawnSync` against a stale Cellar path (`/opt/homebrew/Cellar/node/0.0.0-removed-by-brew/bin/node`) returns ENOENT — the same shape as the luna server log line.
2. The resolver returns a working fallback when execPath is stale. A child process spawned against the resolved path executes successfully.
3. `fix-better-sqlite3.cjs` resolves a stable Node binary at module load (resolver and script both present, exported helpers callable).
4. The resolver fails closed when no Node is reachable anywhere — does not silently pick a phantom path.
5. The resolver rejects non-executable files even when they exist at the requested path (defence against `chmod -x` or write-only files).

Plus seven unit tests in `tests/unit/resolveNodeBinary.test.ts` covering the full fallback chain branch-by-branch.

The live fix on luna (manually-invoked `fix-better-sqlite3.cjs` via the resolved Node binary) brought her degradation count from 8 to 1, with SemanticMemory, TopicMemory, FeatureRegistry, and the pending-relay queue all returning to healthy. With this PR landed, the same recovery will run automatically on every server restart that detects the mismatch.

## What to Tell Your User

If your agent ever logged "rebuild failed (spawnSync ... ENOENT)" after a Homebrew Node update — most often visible as your knowledge graph or conversation summaries going offline while the agent still appears to be running — this fix lets the agent recover on the next restart without manual help. The heal now tries multiple Node paths instead of just the one the server happened to launch with, so a brew-swept-out-from-under-us Cellar path no longer blocks rebuild.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Heal survives stale `process.execPath` | automatic on next server restart |
| DegradationReporter event on heal failure | automatic — surfaces through existing `/degradations` and any consumers watching that channel |
