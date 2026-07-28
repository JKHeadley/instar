---
title: Native-module self-heal must target the running Node's ABI, prefer the prebuilt, and never brick
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Direct user directive (Justin, 2026-05-29, topic 13435): "if Codey is having
  ANY problems it's your responsibility to fix them, and fix them in a way that
  enables Codey to self-heal moving forward, ESPECIALLY if they are problems
  that can affect other Instar agents." Root-caused on the live instar-codey
  agent (sqlite subsystems offline 16h). Same fleet class as #535.
eli16-overview: NATIVE-MODULE-HEAL-ABI-CORRECT-SPEC.eli16.md
date: 2026-05-29
---

# Native-module self-heal: ABI-correct, prebuilt-first, no-brick

## Problem (fleet-wide; observed live on instar-codey)

When Node is upgraded after Instar was installed, better-sqlite3's native
binding no longer matches the running Node's ABI and every sqlite-backed
subsystem (knowledge graph, conversation summaries, stop-gate, feature
discovery, token ledger) goes offline. Two self-heal paths exist to rebuild it:
the ServerSupervisor boot-time **preflight** and the runtime **NativeModuleHealer**.
Both were broken in the same three ways, which left instar-codey's sqlite
offline for 16 hours:

1. **Wrong-ABI rebuild.** Both ran the rebuild via `npm`, but `node-gyp` /
   `prebuild-install` resolve `node` from `PATH`. instar-codey's launchd `PATH`
   has an asdf-managed Node 22.18.0 (ABI 127) ahead of its server's Node 25.6.1
   (ABI 141), so the rebuild "succeeded" while compiling for ABI 127 — which the
   server's Node 25.6.1 then could not load ("rebuild succeeded but module still
   fails to load"). Confirmed: the on-disk binary loaded under ABI 127 and
   failed under ABI 141.

2. **Compile-only heal.** Both used `npm rebuild --build-from-source`, which
   ALWAYS invokes node-gyp to compile and NEVER fetches a prebuilt. On a box
   without a working C++ toolchain the compile fails outright — so the heal can
   never succeed, regardless of ABI. (Reproduced: from-source compile fails on
   the affected box; `npm install better-sqlite3@<ver>` fetches the correct-ABI
   prebuilt in ~2s and loads cleanly.)

3. **Binary-deletion footgun.** `--build-from-source` deletes
   `build/Release/*.node` before compiling. A failed compile therefore leaves
   the agent with NO module at all — strictly worse than the wrong-ABI
   degradation it started from (a missing module can crash subsystem init,
   whereas a wrong-ABI module degrades gracefully). Reproduced live: a manual
   from-source rebuild deleted instar-codey's only binary.

## Design

Apply the same three corrections to BOTH heal paths
(`ServerSupervisor.preflightSelfHeal` and `NativeModuleHealer.healBetterSqlite3Sync`):

1. **Pin the toolchain to the running/server Node.** Prepend that Node's
   directory to the rebuild env `PATH` (and set `npm_node_execpath`) so node-gyp,
   prebuild-install, and any `#!/usr/bin/env node` shebang resolve the correct
   Node — and therefore the correct ABI — even when another Node is first on the
   ambient `PATH`.

2. **Prefer the prebuilt; compile only as a fallback.** Attempt
   `npm install better-sqlite3@<pinned-version> --no-save --prefix <dir>` first:
   this runs better-sqlite3's install script (`prebuild-install`), which fetches
   the prebuilt for the (now correctly-pinned) Node ABI with no compiler. Only if
   that fails fall back to `npm rebuild --build-from-source --ignore-scripts`.
   Verify the module loads after each attempt (the preflight verifies by loading
   under the server Node; the runtime healer verifies via its caller's retry-open).

3. **Atomic, no-brick replace (preflight).** Back up the existing binary before
   rebuilding and restore it if no attempt produces a loadable module, so a
   failed heal can never leave the agent with no module. The runtime healer's
   prebuilt-first attempt does not pre-delete the binary, removing the deletion
   window in the common case.

## Convergence notes (adversarial self-review)

- *Does running better-sqlite3's install script reintroduce a supply-chain risk
  the prior `--ignore-scripts` avoided?* The prebuilt attempt is a targeted,
  version-pinned install of one well-known package — the same path a normal
  `npm install instar` already takes to obtain better-sqlite3. The from-source
  fallback retains `--ignore-scripts`.
- *Could the version pin be wrong?* The version is read from the package's own
  `package.json`; if absent, the bare spec is used. Either way the post-attempt
  load check is authoritative.
- *Restoring the wrong-ABI backup keeps sqlite degraded — is that acceptable?*
  Yes: degraded-but-running beats a missing module that crashes init; the next
  boot retries, and the prebuilt path heals once reachable.
- *Both paths now run under the correct Node — any regression for agents that
  were already healthy?* No: a loadable module is detected by the unchanged
  load-test gate and skips the rebuild entirely.

## Testing

- **Unit** `tests/unit/server-supervisor-preflight.test.ts` (3 new): rebuild env
  `PATH` is pinned to the server Node dir; the prebuilt (`npm install`) is tried
  before any `--build-from-source` compile; a failed rebuild restores the prior
  binary (no-brick). Existing load-test-gating tests still pass.
- **Unit** `tests/unit/NativeModuleHealer.test.ts` (1 new): the runtime rebuild
  prefers `npm install` (prebuilt) and pins `PATH` + `npm_node_execpath` to the
  running Node. Existing 37 healer tests still pass.
- **At-scale (manual, real artifact):** on the affected box,
  `npm install better-sqlite3@12.10.0` under the server Node (PATH-pinned)
  fetched the ABI-141 prebuilt in ~2s and loaded cleanly; `npm rebuild
  --build-from-source` failed to compile. instar-codey's 7 sqlite DBs all open
  cleanly once the correct-ABI binary is in place.

## Migration parity

Server-internal lifeline/monitoring code, not an agent-installed file — every
agent receives the corrected self-heal by running the new server build; no
PostUpdateMigrator entry required.
