# Side-Effects Review — Native-module self-heal source-build fallback + loop-breaker

**Version / slug:** `native-module-source-build-fallback`
**Date:** `2026-04-21`
**Author:** `echo`
**Second-pass reviewer:** `not required (no runtime gate; install-time self-heal with deterministic terminal condition)`

## Summary of the change

`scripts/fix-better-sqlite3.cjs` — the startup self-heal for better-sqlite3 native bindings — gains two things: (1) a source-build fallback via `npm rebuild better-sqlite3 --build-from-source` when the prebuild is missing or the downloaded binary still fails to load, and (2) an attempt-state tracker at `<better-sqlite3>/.instar-fix-state.json`, keyed by `(version, MODULE_VERSION, platform, arch)`, that makes the script short-circuit after it has exhausted both paths on the current tuple. This closes the launchd-respawn-redownload loop seen on Dawn's machine 2026-04-20.

Files touched:
- `scripts/fix-better-sqlite3.cjs` — rewrite (still CLI-invocable; now also exports pure helpers for unit tests)
- `tests/unit/fix-better-sqlite3-state.test.ts` — new, 8 scenarios
- `upgrades/NEXT.md` — new release note
- `upgrades/side-effects/native-module-source-build-fallback.md` — this artifact

Decision points it interacts with:
- The caller `ensureSqliteBindings` in `src/commands/server.ts` treats script exit 0 as "bindings are good," non-zero as "degrade to JSONL-only." That contract is unchanged; the script just becomes smarter about when to give up.

## Decision-point inventory

- `fix-better-sqlite3.main()` — modify — adds a source-build branch and a loop-breaker branch. Still returns 0 for "bindings good" and 1 for "give up; degrade."
- `recordAttempt` / `readState` / `writeState` — add — pure state-file helpers, no runtime gate.
- `tupleKey` — add — identity function over `(version, MODULE_VERSION, platform, arch)`; used only for state keying.
- No new block/allow path. No new runtime authority anywhere.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only "block" in this script is the loop-breaker exit 1 when the current tuple has a `source-failed` marker. Scenarios where that would be wrong:

- **Toolchain installed after a prior failure.** User had no Xcode CLT when source-build last failed, then installed CLT. Script would still short-circuit. Mitigation: the error message explicitly tells the user to remove `<better-sqlite3>/.instar-fix-state.json` to force another attempt. Acceptable — the loop-breaker's raison d'être is preventing crash-loops, and a one-off manual file removal is the right escape valve.
- **Tuple change across the invocation.** If npm rebuild during the Stage-3 source-build branch mutates the installed `better-sqlite3` version, the tuple key changes and the loop-breaker would not short-circuit. The code compares `existing.key === currentKey` — a mismatch means the prior state is not a bar. Correct by construction.

## 2. Under-block

**What failure modes does this still miss?**

- **Transient network failure during prebuild.** First attempt curl-fails → marked `prebuild-failed` → next startup skips straight to source build even though the prebuild might now be reachable. Acceptable: source build is slower but more reliable; the user's machine benefits from a working binary one way or another.
- **Partial source build** — if `npm rebuild` exits 0 but produces no usable binary (unlikely; the post-build `testBinary` catches this), we'd record `source-ok` but the binary would still fail at runtime. Mitigated by `testBinary` gating the `source-ok` recording.
- **Corrupted state file.** `readState` returns `null` on parse error — the script then proceeds as if no prior attempt existed, retrying both paths. Acceptable.

## 3. Level-of-abstraction fit

Right layer. This is install-time / boot-time machinery that's invoked before any runtime subsystem initializes. It doesn't touch any runtime decision point. The state file sits next to the npm package it remediates, not inside `.instar/state/`, because the remediation target IS the node_modules directory — stale state is naturally invalidated whenever npm reinstalls.

The attempt-state tracker is NOT a detector-vs-authority concern because the logic is deterministic and has no brittle pattern-matching: `(version, MODULE_VERSION, platform, arch)` tuple equality + `lastResult === 'source-failed'` check. It's mechanical idempotency, not a classifier.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] **No** — this change has no block/allow surface at the runtime-authority layer. The script either ensures the binary works (exit 0) or declares itself exhausted (exit 1). The runtime caller decides what to do with that information (currently: log + degrade to JSONL-only mode).

The loop-breaker's exit 1 is not a "block" in the signal-vs-authority sense — it's a terminal condition on a self-heal attempt, with deterministic inputs (file contents + env snapshot), not a classifier over user/agent behavior.

---

## 5. Interactions

- **Shadowing.** `src/commands/server.ts::ensureSqliteBindings` has a fallback branch that runs `npm rebuild better-sqlite3` directly when the fix script file is absent. The fix script IS present in normal installs, so that branch is only reached in unusual deploys (e.g., scripts/ directory stripped). No change in behavior there.
- **Shadow-install update.** `src/core/UpdateChecker.ts::applyUpdate` runs `npm rebuild better-sqlite3` under the shadow-install's own node_modules. The fix script's state file lives next to the package, so each shadow install gets its own state. No cross-contamination.
- **Race with launchd respawn.** Previous failure mode: crash → respawn → same redownload → crash. New behavior: crash → respawn → script reads state, sees `source-failed` → exit 1 → `ensureSqliteBindings` degrades to JSONL-only → server stays up without sqlite. This is the intended outcome.
- **Concurrency.** `execSync` is synchronous; the script holds a single logical critical section. No two fix scripts should run simultaneously on the same node_modules tree; if they did, the later state-file write wins, which is acceptable (last-writer-wins semantics match the script's own retry behavior).

## 6. External surfaces

- **Network.** Same curl call as before (unchanged URL, same 30 s timeout). Now optionally followed by an npm rebuild which fetches headers via node-gyp the first time. node-gyp downloads Node headers to `~/.node-gyp/` by default — this is npm's well-trodden default path and not a new external surface for instar.
- **Filesystem.** New state file at `<better-sqlite3>/.instar-fix-state.json`. Written with default permissions (not security-sensitive). Confined to the npm package directory, which is already machine-local and not synced.
- **No changes visible to other agents, other users, other systems.** Pure local self-heal.

## 7. Rollback cost

Trivial. Revert the PR. Script reverts to single-strategy download-only behavior. `.instar-fix-state.json` files left behind by the new version are ignored by the old version (unknown field); no migration needed. No data loss.

---

## Conclusion

Install-time self-heal improvement. No runtime decision surface. Loop-breaker is the key addition — prevents a diagnosed infinite crash-loop under launchd KeepAlive. Source-build fallback is the reliability addition — covers Node versions without published prebuilds. Both are additive safety; nothing that previously worked will stop working.

Safe to ship.
