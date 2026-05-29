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

> **Increment 4 (EscalationSpool — Scope C foundation):** adds
> `src/core/EscalationSpool.ts` — the machine-level (`~/.instar/`, outside any
> TCC folder) durable JSONL queue of outage pages, with one-shot-per-episode
> dedup keyed on the STABLE `label + firstDetectedDown` anchor (persisted in
> `~/.instar/escalation-episodes/` so it survives ticks even when the agent's
> own state dir is locked). Entries carry NO secret — routing + cause +
> remediation only. `firstDetectedDown`/`clearEpisode` manage episode lifecycle;
> `appendEscalation` dedups; `markDelivered` is idempotent; reads tolerate
> malformed lines. Atomic 0600 writes. 10 unit tests incl. dedup, new-episode-
> after-recovery, mode-0600, stable-anchor, malformed-line tolerance. **Not yet
> consumed** — the migrator's EPERM-blocked branch + the watchdog (Scope B) + the
> consented drain (Scope C delivery) wire to it in later increments.

> **Increment 5 (migrateRuntimeRoot orchestrator — wires Scope A together):**
> adds `classifyRelocation` (pure decision: already-relocated FIRST → macOS gate
> → TCC-folder gate → source-readable guard) to `InstarRuntimeRoot.ts` (+5 tests,
> both sides of every gate), and `PostUpdateMigrator.migrateRuntimeRoot()` — a
> `migrate()`-body method (actually runs; the registerStep engine is dormant)
> that gathers facts and acts: skip / blocked-tcc-blind (write
> `~/.instar/relocate-blocked/<label>.json` + `appendEscalation` — NO move) /
> relocate (`relocateRuntime` + `installAutoStart(runtimeRoot)` plist rewrite).
> `installAutoStart` gained a `runtimeRoot` passthrough. **KEY SAFETY PROPERTY:**
> the source-readable guard doubles as the stage-only guard — a launchd-spawned
> TCC-blind process can't read the source → 'blocked' → never moves or rewrites
> the plist, so the bootout/bootstrap in `installAutoStart` only ever runs from a
> consented context. 3 orchestration tests (wired-into-migrate, safe-skip-no-
> mutation, NEW-R1 already-relocated-short-circuit-when-source-unreadable). 61
> tests green across new + adjacent migrator suites. **Scope A now functionally
> complete except** the `instar relocate` CLI + boot consistency assertion (next).

> **Increment 6 (Scope A completion — relocate CLI + boot consistency):** adds
> `instar relocate` (`src/commands/relocate.ts` + `cli.ts` registration) — the
> one consented command that relocates a dead-before-fix agent; it reuses the
> tested orchestrator via a new `PostUpdateMigrator.relocateRuntimeRootNow()`
> public wrapper (one relocation code path). Adds `checkRuntimeRootConsistency`
> (NEW-4 split-brain guard: symlink target vs `--runtime-root` arg) + 4 tests,
> wired as a loud-but-non-fatal warning in `startServer` boot (crashing a
> recoverable agent over a symlink mismatch is worse; doctor surfaces it as
> `symlink-arg-mismatch`). **Scope A COMPLETE.** 71 tests green across the suite.

> **Increment 7 (Scope B foundation — fleet-watchdog TCC classifier + spool):**
> `instar-watchdog.sh` gains `classify_and_spool_tcc_blocked` wired FIRST in the
> crash-loop branch (skips generic self-heal that can't fix TCC). PRIMARY signal
> is `LastExitStatus==78` + `ProgramArguments[0]` under a TCC folder (no `log show`
> required — Apple's wording is unstable). On match: persists a STABLE
> `firstDetectedDown` episode marker in `~/.instar/escalation-episodes/<label>.json`
> and appends a deduped entry to `~/.instar/watchdog-escalations.jsonl` (matches
> the on-disk JSONL shape `EscalationSpool.ts` reads, so consented drainers see
> the same entries). New helpers `get_program_argv0` / `is_tcc_protected_path`
> (Documents/Desktop/Downloads/iCloud Drive). New `INSTAR_WATCHDOG_LIB_ONLY=1`
> source-mode lets tests exercise helpers without the main supervision loop. 11
> tests (7 content + 4 darwin-gated behavioral: classify+spool, non-78
> falls-through, non-TCC-path falls-through, one-shot dedup across ticks). 35
> tests green across new + existing watchdog suites. **Not yet wired:** runtime-
> root resolution from plist (replaces `$project_dir/.instar` reads), direct-
> Telegram delivery (needs Scope C credential), SessionStart-hook drain.

> **Increment 8 (EscalationCredential — Scope C delivery foundation):** adds
> `src/core/EscalationCredential.ts` — minimal per-agent `{ ownerTopicId, botToken }`
> at `~/.instar/registry/<bundleId>.json`, mode 0600 in 0700 dir, atomic mode-at-
> creation write, structural protections (outside any TCC folder, outside any
> project git tree — both the launchd-spawned watchdog can read it AND the Luna
> `.bak`-in-git-tree leak vector cannot apply). Validates token shape before
> writing (an empty/garbage credential would have the watchdog 401-forever
> instead of falling through to the consented drain). Rejects path-traversal
> bundle ids at the filename layer. Idempotent re-write (`unchanged` return)
> avoids fsync churn on every healthy boot. 12 unit tests. **Not yet consumed:**
> setup needs to write it (consented); server boot needs to refresh it on
> healthy start; watchdog needs to read it for direct Telegram send. Those wire
> up in the next increment.

> **Increment 9 (watchdog direct-Telegram send — token-never-in-argv proven):**
> `try_direct_telegram_send` reads `~/.instar/registry/<label>.json`, validates
> token shape, and sends to Telegram via `printf | curl -K -` — printf is a bash
> BUILTIN, so the token is NEVER on any process's argv (no `ps` exposure); the
> URL containing the token is fed to `curl -K -` via STDIN, not argv. Wired into
> the classifier after a successful `spool_append`: armed agents get autonomous
> Telegram paging; unarmed agents stay in the spool for the consented drain.
> Best-effort + non-fatal — a send failure leaves the spool entry intact.
> 2 new behavioral darwin-gated tests with a mock-curl shim that captures its
> argv to disk and asserts the bot token literally does not appear there
> (structural proof of the security property, not just a content claim).
> Also: fixed an `echo`+`tr -c` bug where the trailing newline was being
> translated to a `_`, mangling the credential filename + episode-marker label.
> 14 watchdog tests green; 118 across the full new+adjacent suite. **Still
> needed:** wire setup + healthy-boot to WRITE the credential (the writer side
> of Scope C); without it, no agent gets armed.

> **Increment 10 (credential-writer wiring — chain end-to-end for armed agents):**
> `startServer` now writes/refreshes the per-agent EscalationCredential on every
> healthy boot (idempotent — `unchanged` return avoids fsync churn). `instar
> relocate` writes the credential after a successful relocation (the b2lead
> bootstrap path: one consented run both recovers AND arms — every death AFTER
> that pages autonomously). Both pull `{ token, chatId }` from the agent's own
> Telegram messaging config (same source the lifeline polls), so the credential
> stays in lockstep with what's authoritative; a rotated token propagates within
> one healthy boot. **The autonomous-paging chain is now end-to-end functional
> for armed agents** (exit-78 → spool → direct Telegram via the credential,
> token never in argv). **Still ahead:** Scope D's SessionStart-hook spool drain
> (the b2lead-before-fix path, where no credential exists yet) + the watchdog's
> own runtime-root resolution rework (stops reading `$project_dir/.instar` for
> relocated agents) + Scope E FDA bootstrap + e2e tier + migration parity + CI
> grep-gate + live verification + merge.

> **Increment 11 (SessionStart spool drain — closes the b2lead-before-fix path):**
> The SessionStart hook now drains `~/.instar/watchdog-escalations.jsonl` in
> Python (urllib.request — no curl subprocess, no token-in-argv risk). The drain
> runs FIRST in the hook (before the agent-config check exits), so it works
> regardless of the host agent's state. A Claude session is a CONSENTED context
> with TCC keys → it can read the dead agent's Documents-resident config.json
> that the launchd-spawned watchdog cannot on macOS 26, and uses the agent's own
> Telegram credential to deliver the page. Atomic rewrite (temp+rename, 0600)
> on success. Idempotent (delivered:true entries skipped). Fast-path (`[ -s "$SPOOL" ]`)
> skips the Python invocation entirely when no spool exists — the steady-state
> for healthy machines. Honors `INSTAR_TELEGRAM_API_BASE` for test mocking.
> 11 tests (8 content + 3 darwin behavioral with a real local HTTP mock server:
> delivers+marks-delivered+atomic-rewrite; idempotent skip; no-telegram-config
> no-op). **Both directions of the paging chain now reach the user: armed agents
> via the watchdog's direct send, unarmed b2lead-before-fix agents via the next
> consented Claude session's drain.**

> **Increment 12 (watchdog runtime-root resolution — Scope B complete):** the
> three watchdog functions that read agent state (`try_self_heal`,
> `probe_server_identity`, `check_stale_lifeline_signal`) now resolve their state
> dir via a new `resolve_state_dir_for_plist` helper that reads the absolute
> `--runtime-root` arg from the plist's `ProgramArguments` — NOT by traversing
> `$project_dir/.instar` (a Documents-resident symlink readlink EPERMs under
> launchd-spawned context on macOS 26, which is the watchdog's case). Falls
> back to `$project_dir/.instar` ONLY when the plist has no `--runtime-root`
> (unrelocated agents). 3 new tests (1 content asserts all three consumers wire
> through the helper; 2 darwin behavioral confirm both layers — relocated reads
> absolute Library, unrelocated falls back to project). 17 watchdog tests green.
> **Scope B is now COMPLETE.** The launchd-spawned watchdog can correctly
> probe/heal/signal a relocated agent on macOS 26 without ever traversing the
> TCC-locked Documents path.

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
