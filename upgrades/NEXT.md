# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed the better-sqlite3 self-heal so an agent reliably recovers its SQLite
subsystems after a Node upgrade.** When Node is upgraded after Instar is
installed, the compiled better-sqlite3 module no longer matches and every
SQLite-backed subsystem (knowledge graph, conversation summaries, stop-gate,
feature discovery, token ledger) goes offline. The auto-repair that rebuilds it
was broken three ways — found live on an agent whose SQLite was dark for 16h:

1. It rebuilt for the **wrong Node ABI** — the build tool resolves `node` from
   `PATH`, and if another Node (e.g. an asdf-managed one) is ahead of the
   server's Node, the rebuild "succeeds" but the server still can't load it.
2. It **only knew how to compile** (`npm rebuild --build-from-source`), which
   fails outright on a machine without a C++ toolchain — and never tried the
   far simpler option of downloading the ready-made prebuilt.
3. The compile **deletes the old binary first**, so a failed compile left the
   agent with no SQLite module at all (worse than the wrong-version one).

Both heal paths (boot-time preflight and runtime) now: pin the build to the
**server's Node** (correct ABI regardless of PATH), **fetch the prebuilt first**
(via `npm install`, ~2s, no compiler) and only compile as a fallback, and — at
boot — **back up and restore** the prior binary so a failed heal can never brick
SQLite.

## What to Tell Your User

If an agent ever lost its memory/knowledge-graph/summaries after an update
("running but degraded"), this makes the automatic recovery actually work — it
now refetches the correct prebuilt database engine for your Node version,
without needing a compiler, and can't leave the agent worse off than it started.
No action needed.

## Summary of New Capabilities

- better-sqlite3 self-heal targets the server/running Node's ABI (PATH-pinned),
  so a rebuild can't silently target the wrong Node.
- Prebuilt-first heal: fetches the correct-ABI prebuilt (no compiler) before
  falling back to a from-source compile.
- Boot-time heal is atomic: backs up and restores the prior binary if no rebuild
  attempt produces a loadable module (no-brick).

## Evidence

- `tests/unit/server-supervisor-preflight.test.ts` (+3): PATH pinned to the
  server Node dir; prebuilt (`npm install`) tried before any compile; prior
  binary restored when no attempt yields a loadable module.
- `tests/unit/NativeModuleHealer.test.ts` (+1): runtime rebuild prefers
  `npm install` (prebuilt) and pins PATH + npm_node_execpath to the running Node.
- At-scale (manual, affected box): `npm install better-sqlite3@12.10.0` under the
  server Node (PATH-pinned) fetched the ABI-141 prebuilt in ~2s and loaded
  cleanly, where `npm rebuild --build-from-source` failed to compile. The
  affected agent's 7 SQLite DBs all open cleanly once the correct binary is in
  place.
- Side-effects: `upgrades/side-effects/native-module-heal-abi-correct.md`.
