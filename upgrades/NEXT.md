---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; Codey-down native-module ABI incident)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the last better-sqlite3 heal path is now prebuilt-first

An agent (instar-codey) went offline for hours after a Node upgrade: a new Node
was installed, the boot wrapper repointed the agent at it, but the agent's
better-sqlite3 native module was still built for the old Node's ABI and could no
longer load. The agent is supposed to self-heal by rebuilding better-sqlite3 — and
two of its three rebuild paths already do this the fast, robust way (try the
prebuilt binary first via `npm install`, which needs no C++ toolchain; compile
from source only as a fallback). The **third** path —
`NativeModuleHealer.healBetterSqlite3FromRemediator`, used by the
`supervisor-preflight` self-healing runbook — was still **from-source-only**
(`npm rebuild --build-from-source`), which cannot heal a box without a working
compiler. That is exactly the situation that bricked Codey.

This change makes that third path mirror the other two: **prebuilt-first**, with a
PATH pinned to the running Node so the rebuilt module targets the correct ABI, and
a scoped `--ignore-scripts` from-source fallback. It relaxes the (aspirational,
unimplemented) "build-from-source preferred" spec stance — flagged in the spec for
review — but introduces no new divergence: both shipped boot heal paths are
already prebuilt-first, and the spec's sha256-pinned lockfiles do not exist yet.

## Summary of New Capabilities

- `NativeModuleHealer.healBetterSqlite3FromRemediator` is now prebuilt-first
  (`npm install better-sqlite3@<pinned>` → `npm rebuild --build-from-source
  --ignore-scripts` fallback), toolchain PATH-pinned to `process.execPath`'s dir,
  matching `healBetterSqlite3` and `ServerSupervisor.preflightSelfHeal`.
- The self-healing remediator's native-module rebuild can now recover a
  node-ABI-mismatch on a machine without a C++ build toolchain.

## What to Tell Your User

If you ever upgrade Node on a machine running your agent, your agent can now heal
its database engine without needing a compiler installed. It grabs the ready-made,
correct-version binary first and only falls back to building from scratch if that
download fails. This closes the gap that took one of our agents offline for hours
after a Node bump. Nothing to configure — it applies on the next update.

## Evidence

- Root cause traced live in instar-codey logs: a homebrew Node 25.6.1 install
  self-healed the agent's node link forward (ABI 141) while shadow-install
  better-sqlite3 was ABI 127, and the from-source-only remediator rebuild could
  not produce a loadable module without a toolchain.
- The two boot heal paths were confirmed already prebuilt-first
  (`src/memory/NativeModuleHealer.ts` healBetterSqlite3, lines ~445-446;
  `src/lifeline/ServerSupervisor.ts` preflight, lines ~855-856); the
  `dist/native-source.lock.json` / `dist/native-prebuilds.lock.json` lockfiles do
  not exist in the tree.
- Unit: `tests/unit/NativeModuleHealer-invokeFromRemediator.test.ts` — new cases
  prove prebuilt-first heals in one step and falls back to from-source on prebuilt
  failure; all prior guard/sha256/once-per-process cases stay green.
- Regression: NativeModuleHealer + Remediator + node-abi-mismatch runbook +
  find/fix-better-sqlite3 suites — 96 tests pass.
- `tsc --noEmit` clean; `npm run lint` clean.
- Spec: `docs/specs/remediator-heal-prebuilt-first.md` (+ `.eli16.md`); V3
  consolidated spec §7.1 annotated.
- Side-effects: `upgrades/side-effects/remediator-heal-prebuilt-first.md`.
