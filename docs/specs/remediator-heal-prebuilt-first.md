---
title: Remediator better-sqlite3 heal — prebuilt-first (align the last from-source-only path)
slug: remediator-heal-prebuilt-first
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-second-pass-2026-05-31
approved: true
approved-by: echo (standing 12h autonomous deploy mandate, topic 13435)
approval-note: >
  Self-approved under the standing deploy mandate. Directly serves the mandate's
  Codey-down incident: instar-codey was offline for hours after a homebrew node
  25.6.1 install left its shadow-install better-sqlite3 (ABI 127) unloadable
  under the self-healed node (ABI 141). This aligns the LAST better-sqlite3 heal
  path with the two already-shipped boot heal paths. It RELAXES the aspirational
  §A45/§7.1 "build-from-source preferred" stance — flagged transparently below
  for Justin's PR review — but introduces no new divergence: both shipped boot
  heal paths are ALREADY prebuilt-first plain `npm install`, and §7's
  sha256-pinned-lockfile design is unimplemented (the lockfiles do not exist).
second-pass-required: false
second-pass-status: n/a-consistency-fix-mirrors-two-shipped-paths
eli16-overview: remediator-heal-prebuilt-first.eli16.md
---

# Remediator better-sqlite3 heal — prebuilt-first

## Background — the Codey-down incident (2026-05-31)

`instar-codey` was down for hours. The launchd-managed lifeline kept failing to
bring the server up. Root cause (from `logs/lifeline-launchd.err`): a homebrew
**node 25.6.1** install caused the boot wrapper (`instar-boot.cjs`) to self-heal
`.instar/bin/node` **forward** to ABI 141, but the shadow-install
`better-sqlite3@12.10.0` binary was ABI 127 → `ERR_DLOPEN_FAILED
(NODE_MODULE_VERSION 127 vs 141)`. The supervisor's rebuild "could not produce a
loadable module" and restored the ABI-127 binary ("sqlite stays degraded, not
bricked"), so node-25 still could not load it and launchd throttling stretched
the restart loop into a multi-hour outage. (The `last exit code = 78 EX_CONFIG`
that looked like the cause was a stale red-herring — no code in the running
install exits 78.) Resolved operationally: a fresh bootstrap from a context with
a working toolchain healed the ABI state and Codey came back up, stable, polling.

## The durable code finding

instar has **three** better-sqlite3 rebuild paths. PR #539 (v1.3.100) made two of
them **prebuilt-first** — attempt the prebuilt via plain `npm install
better-sqlite3@<pinned>` (which runs `prebuild-install` to fetch the correct-ABI
binary in ~2s, **no C++ toolchain needed**), then fall back to a from-source
compile:

- `NativeModuleHealer.healBetterSqlite3` (the `openWithHeal` inline path) ✓
- `ServerSupervisor.preflightSelfHeal` native-module branch (the boot path) ✓

The **third** — `NativeModuleHealer.healBetterSqlite3FromRemediator` (the W-1
`supervisor-preflight` remediation runbook surfaceCallable) — was still
`npm rebuild --ignore-scripts --build-from-source`-**only**, with **no** prebuilt
attempt and **no** PATH-pin to the running Node. `npm rebuild` always
node-gyp-compiles and never fetches a prebuilt, so this path **cannot heal a box
without a working C++ toolchain** — exactly the node-ABI-bump failure that took
Codey offline. It is the last rebuild surface #539 missed.

## Design

Make `healBetterSqlite3FromRemediator` mirror its two siblings:

1. **PATH-pin** the toolchain to `process.execPath`'s directory
   (`npm_node_execpath` + `PATH` prefix) so node-gyp / prebuild-install / any
   `#!/usr/bin/env node` shebang resolve the **correct** ABI even when another
   Node (e.g. an asdf 22.x) is first on `PATH`. Without this, even the from-source
   compile can target the wrong ABI ("rebuild succeeded but module still fails to
   load").
2. **Prebuilt-first attempts array**, identical shape to the siblings:
   - `['install', 'better-sqlite3@<pinned>', '--no-save', '--prefix', prefix]`
     — runs scripts so prebuild-install fetches the correct-ABI prebuilt.
   - `['rebuild', '--build-from-source', '--ignore-scripts', 'better-sqlite3',
     '--prefix', prefix]` — scoped from-source fallback.
   Loop, breaking on the first `status === 0`. The abort signal is honoured at
   the top of each iteration; an all-throw path returns a `spawn failed` failure;
   the post-rebuild sha256 record (§A28) and `RemediatorExecutionResult` shape are
   unchanged.

## §A45 / §7.1 amendment (flagged for review)

The original SELF-HEALING-REMEDIATOR spec §7.1 states "Build-from-source
preferred" with a sha256-pinned prebuild only "when build-from-source isn't
feasible" (§7.2), each verified against `dist/native-source.lock.json` /
`dist/native-prebuilds.lock.json`. This change **relaxes** that for the remediator
path: prebuilt-**first**, plain `npm install` (no lockfile verification). This is
**not a new divergence**:

- Both shipped boot heal paths (#539) are already prebuilt-first plain
  `npm install` — so §7.1's "build-from-source preferred" is already not honored
  by any shipped heal path.
- The §7 sha256 lockfiles (`native-source.lock.json`,
  `native-prebuilds.lock.json`) **do not exist** in the tree — the pinned-manifest
  design is aspirational/unimplemented; no heal path verifies against them.

So this change makes the codebase **internally consistent** (all three heal paths
prebuilt-first) rather than introducing novel risk. The supply-chain exposure of
the prebuilt fetch is exactly that of the two shipped boot paths and of any normal
`npm install`: a single pinned package from better-sqlite3's official release. The
from-source fallback retains `--ignore-scripts`. **The real future hardening — the
§A55 sha256 lockfile verification — should be implemented for all three heal paths
together; it is tracked as follow-up, not blocked by this change.** The V3
consolidated spec §7.1 is annotated to point here.

## Test plan

- **Unit** (`tests/unit/NativeModuleHealer-invokeFromRemediator.test.ts`):
  - prebuilt-first: a successful `npm install` heals without reaching the
    from-source fallback (asserts attempt-1 args = `install` + pinned spec +
    `--no-save`, NOT `--ignore-scripts`/`--build-from-source`).
  - fallback ordering: when the prebuilt install fails, attempt-2 is the scoped
    `rebuild --build-from-source --ignore-scripts better-sqlite3`, and the heal
    still succeeds.
  - All pre-existing cases (abort/deadline/budget guards, sha256 record, non-zero
    exit, missing prefix/npm, once-per-process guard, legacy openWithHeal) stay
    green.
- **Regression**: the full NativeModuleHealer + Remediator + node-abi-mismatch
  runbook + find/fix-better-sqlite3 suites (96 tests) stay green.
- This is an internal heal-path change (no new HTTP route), so the relevant
  coverage tiers are unit (logic) + the existing remediator regression suites; no
  new route means no new integration/e2e surface to assert "alive".
