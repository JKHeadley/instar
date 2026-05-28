# Side-Effects Review — macOS 26 launchd-TCC runtime relocation

**Version / slug:** `macos26-launchd-tcc-runtime-relocation`
**Date:** `2026-05-28`
**Author:** `echo`
**Second-pass reviewer:** `not required (Scope A foundation increment — pure path module + a backward-compatible one-line resolver wiring; full multi-agent review ran at /spec-converge, 4 rounds)`

> This artifact covers the **Scope A foundation** increment: the runtime-root
> resolver module + its wiring into `loadConfig`. Subsequent increments
> (`migrateRuntimeRoot`, `installMacOSLaunchAgent` rewrite, `relocate.ts`,
> watchdog, credential, FDA bootstrap) extend this artifact in-place as they land.

> **Increment 2 (RuntimeRelocator engine):** adds `src/core/RuntimeRelocator.ts`
> — the transactional whole-tree move (`.instar` → runtime root via atomic
> same-volume `rename()`, verify, rollback-by-rename, symlink-back, sentinel-last)
> + helpers (`sweepStalePartials`, `verifyRuntimeRoot`, `sameVolume`). **NOT YET
> WIRED** — `migrateRuntimeRoot` (the orchestrator that gates detection, runs the
> EPERM probe, calls this engine, and rewrites the plist) is the next increment;
> until then this engine is reachable only from its tests. **Tracked deviation
> (Rule 4 — architectural refinement):** the converged spec described "build in
> `<root>.partial`, verify, atomic rename." Implementation uses a *whole-directory
> atomic `rename()`* for the same-volume case instead — instant, atomic, moves
> shadow-install for free, and eliminates the partial-copy/dual-copy class
> entirely (one tree, new path). The `.partial` copy+verify path is retained for
> the cross-volume fallback (rename EXDEVs across volumes), which currently
> returns a typed error so the orchestrator can surface `relocate-needs-network`
> (OQ4, defensive). Rollback is the inverse rename. 9 unit tests incl. happy-path
> move, one-live-copy, verify-fail rollback (probe + missing-config), double-
> relocate refusal, non-empty-root refusal.

## Summary of the change

Adds `src/core/InstarRuntimeRoot.ts` — a pure module that computes where an agent's runtime should live so launchd can always reach it (`~/Library/Application Support/instar/<name>-<hash>/` on macOS, `~/.local/share/instar/...` on Linux), detects whether a directory is under a TCC-protected user folder (Documents/Desktop/Downloads/iCloud), reads the persisted `relocate.json` record, and exposes `resolveStateDir(projectDir, env)` — the two-layer pointer (boot layer reads `INSTAR_RUNTIME_ROOT`; consented layer uses `<projectDir>/.instar`). Wires `loadConfig` (`src/core/Config.ts`) to derive `stateDir`/`configPath` from `resolveStateDir` instead of an inline `path.join(projectDir, '.instar')`. The module has NO filesystem side effects (no moves) — relocation itself is a later increment. Files: `src/core/InstarRuntimeRoot.ts` (new), `src/core/Config.ts` (resolver wiring + import), `tests/unit/InstarRuntimeRoot.test.ts` (new, 19 tests).

> **Increment 3 (plist runtime-root-aware + boot --runtime-root parse):**
> `installMacOSLaunchAgent` now accepts an optional `runtimeRoot` (defaults to
> `<projectDir>/.instar` — byte-identical for non-relocated agents) and threads
> it through: ProgramArguments spawn node + boot wrapper from the root and pass
> `--runtime-root <root>`; `WorkingDirectory` + launchd `StandardOut/ErrPath` →
> the root (fixes the 0-byte-log root cause — launchd couldn't create logs under
> the locked folder). `ensureStableNodeSymlink` + `installBootWrapper` gained an
> optional state-dir override (default unchanged). The plist XML was extracted to
> a pure exported `buildLaunchAgentPlist()` for unit testing. `cli.ts` `server
> start` + `lifeline start` gained `--runtime-root`, setting `INSTAR_RUNTIME_ROOT`
> before `loadConfig` so `resolveStateDir` consumes it — this is the WIRED link
> that makes the boot layer real. Backward-compat verified: 55 existing
> boot/relocation unit tests green. **Still not wired end-to-end:** the
> orchestrator (`migrateRuntimeRoot`) that DECIDES the root + performs the move +
> rewrites the plist is the next increment; until then `installMacOSLaunchAgent`
> is called with no `runtimeRoot` (legacy behavior) everywhere.

## Decision-point inventory

- `loadConfig stateDir computation` (`src/core/Config.ts:603-617`) — **modify** — was `path.join(resolvedProjectDir, '.instar')`, now `resolveStateDir(resolvedProjectDir)`. Behavior is **identical** for every caller unless `INSTAR_RUNTIME_ROOT` is set (only the launchd boot path sets it, in a later increment). No gate/block surface.

---

## 1. Over-block

No block/allow surface — over-block not applicable. `resolveStateDir` is a path selector, not a gate; it returns a directory string and rejects nothing.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

The change lives at the right level: state-path resolution belongs in `Config.loadConfig`, which is the single place that already computed `stateDir`. Centralizing it in `InstarRuntimeRoot.resolveStateDir` (rather than scattering `INSTAR_RUNTIME_ROOT` checks across callers) is the structural funnel the spec's CI grep-gate will protect. Pure path math is separated from the (later) side-effectful relocation, matching how `SafeFsExecutor`/`SafeGitExecutor` separate decision from execution.

## 4. Signal vs authority compliance

No authority surface in this increment. `resolveStateDir` does not block, route, or gate any message or operation — it selects a directory. The TCC-detection helpers (`isUnderTccProtectedRoot`) are signals consumed later by the migrator's detection gate; they do not themselves act.

## 5. Interactions

- **`loadConfig` is called pervasively** (CLI, server, lifeline, migrator, tests). The change is backward-compatible by construction: with `INSTAR_RUNTIME_ROOT` unset (every current install, and every consented/non-relocated context), `resolveStateDir` returns exactly `path.join(projectDir, '.instar')` — byte-identical to the prior behavior. Verified by the unit test "consented layer: falls back to `<projectDir>/.instar` when env unset."
- **No interaction with relocation yet** — nothing moves; the symlink-follow path is the OS's, not this code's.
- **`mergeConfigWithSecrets(fileConfig, stateDir)`** downstream now receives the resolved stateDir; identical when env unset.

## 6. External surfaces

No external/network/secret surface in this increment. `INSTAR_RUNTIME_ROOT` is a process-local env var (set by our own boot path in a later increment), not user input. `relocate.json` is read-only here and contains no secrets (it holds paths + a hash, never tokens — the credential is a separate Scope C artifact).

## 7. Rollback cost

Low. Reverting restores the inline `path.join(projectDir, '.instar')`. No on-disk migration is performed by this increment, so there is no relocated state to un-wind. The new module is additive; deleting it + the one Config edit fully reverts.

## Conclusion

Safe, backward-compatible foundation increment. The only behavioral change is gated behind an env var that nothing sets yet; with it unset the code path is identical to before. 19 unit tests green; full typecheck clean. The risk surface that matters (the actual move, the launchd plist, the credential) lands in later increments, each with its own extension of this artifact.

## Second-pass review (if required)

Not required for this increment (pure module + backward-compatible wiring). The design as a whole passed a 4-round multi-agent `/spec-converge` (security, scalability, adversarial, integration, lessons-aware) — see `docs/specs/reports/macos26-launchd-tcc-runtime-relocation-convergence.md`. The side-effectful increments (migration, plist rewrite, credential) WILL trigger the mandatory second-pass per the instar-dev rule (they touch boot path + secret material).

## Evidence pointers

- Spec: `docs/specs/macos26-launchd-tcc-runtime-relocation.md` (approved + review-convergence tagged)
- Convergence report: `docs/specs/reports/macos26-launchd-tcc-runtime-relocation-convergence.md`
- Tests: `tests/unit/InstarRuntimeRoot.test.ts` — 19 passing (TCC detection both sides, hash disambiguation, two-layer resolver both sides, relocate.json record validation incl. malformed/stale/incomplete).
- Typecheck: `tsc --noEmit` clean.
