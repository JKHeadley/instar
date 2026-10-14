# Side-Effects Review — Retained per-version Claude executable (CMT-798)

**Version / slug:** `retained-claude-executable`
**Date:** `2026-10-14`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (session lifecycle: spawn) — response appended below`

## Summary of the change

Every `claude-code` session spawn (headless, interactive, and the triage pane) now routes its resolved binary path through one new SessionManager chokepoint, `resolveLaunchBinary`, which asks `ClaudeBinaryRetainer` for a per-version RETAINED copy of the Claude Code executable (`<projectDir>/.instar/state/claude-bin/<version>/claude`) and launches from that copy instead of the mutable npm path. A Claude Code npm update replaces `claude.exe` in place, leaving every live session on an unlinked executable; on macOS EndpointSecurity path lookups on that executable fail and leak ~1 KiB of kernel memory each (`data.kalloc.1024`, measured 163 MiB/h on this Mac Studio, which panicked at 20 GiB in that zone on 2026-10-06). A retained copy keeps its directory entry across updates, so the running session's executable stays linked. Old versions are pruned only when no live process maps them and a grace window has passed.

Files: `src/core/ClaudeBinaryRetainer.ts` (new), `src/core/SessionManager.ts` (chokepoint + three call sites + status/prune accessors), `src/core/types.ts` + `src/core/Config.ts` (`sessions.retainedClaudeBinary` config passthrough), `src/server/routes.ts` (`GET /sessions/claude-binary`, `POST /sessions/claude-binary/prune`), `src/core/PostUpdateMigrator.ts` (config default + CLAUDE.md bullet), `src/scaffold/templates.ts` (CLAUDE.md bullet), tests in all three tiers.

## Decision-point inventory

- `SessionManager.resolveLaunchBinary` — add — chooses WHICH file a claude-code session execs. Not a block/allow point: it never refuses a spawn; it substitutes a byte-identical copy or returns the original path.
- `ClaudeBinaryRetainer.resolve` — add — per-spawn: retain (copy once) vs fall back (named reason). Fallback is always toward "launch exactly what was configured".
- `ClaudeBinaryRetainer.prune` — add — deletes old retained version directories. The only destructive decision; three independent gates (not current, past grace, zero live mappers) with "unknown" → keep.
- `resolveFrameworkBinaryPath` (existing impersonation fence) — pass-through — still decides which framework binary is configured; the retainer runs AFTER it and only for `claude-code`.

---

## 1. Over-block

No block/allow surface on the spawn path — the retainer never refuses a launch. The two places it declines to RETAIN (and launches the configured path unchanged) are deliberate: a shebang wrapper script (`script-not-retained`: a script is read by its interpreter, not mapped as the process executable, so it cannot trigger the leak, and relocating it could break relative references) and a path with no `claude`/`claude-code`/`@anthropic-ai`/`.claude` component (`not-claude-binary`: never copy an arbitrary binary). Both are quiet, both are visible on the status route. An operator with an exotic layout (e.g. a renamed binary in an unrelated directory) keeps today's behaviour and the leak; the reason tells them why.

Prune over-block (= over-KEEP) is the chosen direction: an `lsof`-less host, a timed-out probe, or a probe error all KEEP the directory. Cost is disk (~250 MB per retained version), never a deleted executable under a live process.

---

## 2. Under-block

- **Sessions started before this ships** still map their old unlinked executable; nothing here repairs a live mapping (it cannot — only a restart of that session moves it onto a retained copy). The desk schedules those restarts; this change never restarts anything itself. Stated in the CLAUDE.md bullet and the release note.
- **Headless `claude -p` one-shots** spawned by intelligence providers are NOT routed through the retainer. They are short-lived and are launched after any update, so they map the current file; the leak needs a process that outlives an update. If a one-shot straddles an update it leaks for the remainder of its (short) life.
- **Launchers outside instar** (the desk's own `launch-claude-builder.sh` / `spawn-claude-builder.sh`, which call bare `claude`) are not covered by this PR; they live in the agent's lanes directory, not instar source. Named in the desk report so the desk can point them at the retained copy or the route.
- **Prune race**: a version directory could in principle be pruned between `resolve()` choosing it and the process exec'ing it. Mitigated by the 6 h last-used grace (resolve touches the marker; exec follows within seconds) and by prune only ever considering NON-current keys (a spawn always uses the current key). Residual window: a different agent process with a different "current" sharing the same dir — not the default layout (dir is per agent).
- **Same version, same size, different bytes** would reuse the existing copy. Claude Code publishes a new version string per build; this is not a realistic case, and the worst outcome is running the previously retained build of the same version.

---

## 3. Level-of-abstraction fit

Right layer. The spawn chokepoint is the ONE place every claude-code session's executable path is decided (the three call sites all funnel through `resolveLaunchBinary`), which is exactly where "which file do we exec" belongs. A lower layer (the config loader) resolves paths once at boot and would miss mid-run updates; a higher layer (a watchdog that restarts leaking sessions) would be the kill/restart loop the diagnosis explicitly rejected ("do not add a recurring kill/restart watchdog") and would not prevent the leak, only bound it. The existing `resolveFrameworkBinaryPath` fence is reused unchanged for WHAT framework binary is configured; the retainer only answers WHERE to exec it from.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The spawn-path decision is a substitution of a byte-identical file, never a refusal; every uncertainty resolves to "launch what was configured". The one destructive decision (prune) is a deterministic safety guard on an irreversible action (deleting an executable), and per the carve-out it is brittle BY DESIGN in the safe direction: three independent deterministic gates, and any inability to evaluate a gate means keep.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Prune is a safety guard on an irreversible action: the signals (current key, last-used age, live mapper count) do not compete — each one alone is sufficient to KEEP, and deletion requires all three to clear. The retain/fallback choice is enumerable (a closed set of named reasons), not a judgment.

---

## 5. Interactions

- **Shadowing:** the retainer runs AFTER `resolveFrameworkBinaryPath` (the impersonation fence) and only for `claude-code`; it cannot change which framework is launched, only the file's location. `frameworkBinaryExists` checks at the triage site still run against the configured path first (unchanged); the retained path exists by construction when returned.
- **Process-name matchers:** tmux `#{pane_current_command}` becomes `claude` (the retained basename) instead of `claude.exe`. `frameworkInjectionProcesses` allows both (`['claude', 'claude.exe']`); the reaper/stand-down `\bclaude\b` regexes match both. The SessionWatchdog identifies codex by launcher path and claude by command text, unchanged.
- **Double-fire:** none. One retainer per SessionManager; prune is single-flight and throttled to once per hour per process.
- **Races:** two processes (e.g. two agents sharing a configured `dir`) copying the same version concurrently are reconciled by `link()` + EEXIST — one copy wins, the other's tmp is discarded; nothing is ever replaced. Prune vs spawn: see §2.
- **Feedback loops:** none. Prune deletes only what resolve created; resolve never reads prune state.
- **Subscription-pool account swaps / `--resume` / configHome:** untouched; they change the session's HOME and args, not the binary path.
- **SourceTreeGuard / SafeFsExecutor:** the only deletions (prune's `rm -r` of a version dir, the tmp-file unlink) go through `SafeFsExecutor`; the default dir is under the agent's gitignored `.instar/state`, which the guard already permits for sibling stores.

---

## 6. External surfaces

- **Other agents on the same machine:** each agent retains under its own state dir (~250 MB per version per agent); nothing shared, nothing cross-agent. Disk is the only shared resource; prune bounds it.
- **Other users of the install base:** every claude-code agent gets this ON by default via the migrator's `{ enabled: true }` block. Behavioural change visible to them: the tmux pane command reads `claude` rather than `claude.exe`; `GET /sessions` paths unchanged. Linux agents: `/proc` scan for prune; the leak itself is macOS-specific but a retained copy is harmless there.
- **External systems:** none. No network, no Telegram, no GitHub.
- **Persisted state / timing:** the retain dir plus `source.json` manifest and `.last-used` marker per version. Depends on filesystem semantics (`link()` EEXIST atomicity, `copyFile` with `COPYFILE_FICLONE` — a clone on APFS, a plain copy elsewhere; 119 ms for 247 MB in the live check) and on `lsof` being present for prune on macOS (absent → keep).
- **Claude Code's own self-update / install-method detection:** the retained copy runs from a non-npm path. Verified live: `--version` and an interactive session boot normally from the copy (the native installer already runs Claude from a per-version directory, so this layout is one Claude supports). If a future Claude build refused to run from a foreign path, the session pane would show the refusal and the operator flips the off switch; the status route names the retained path.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The retained copy is a per-machine artifact of that machine's installed Claude Code (its version, its architecture, its filesystem); it must never replicate. Nothing here is user-facing (no notices), no durable topic-scoped state exists to strand on transfer, and the status route reports only this machine (no `scope=pool` — a pool read would be meaningful only as per-machine rows, which is a follow-up if anyone asks). A topic moved to another machine simply spawns there from THAT machine's retained copy.

---

## 8. Rollback cost

Config flip: `sessions.retainedClaudeBinary.enabled: false` + a server restart returns to launching the configured path for new spawns; running sessions are unaffected either way (they keep whatever file they exec'd). Code revert is a plain revert of this PR (no data migration — the migrator only ADDS a config block, and the retain dir is inert data that can be deleted at will once no live process maps it; `GET /sessions/claude-binary` lists it). No agent-state repair.

---

## Evidence pointers

- Diagnosis: `~/.instar/agents/echo/.instar/lanes/studio-kmem-leak-1014-PROGRESS.md` (+ `studio-kmem-leak-1014-evidence/`): 163.34 MiB/h in `data.kalloc.1024`, 82,095/83,051 `vn_getpath failed: 0x2` events attributed to seven Claude PIDs, all with `nlink=0` executables; prior panic at 21,105,456 elements (20.13 GiB) on 2026-10-06.
- Live check on this Mac Studio, 2026-10-14 09:45 PDT: retained `/usr/local/bin/claude` → `2.1.299/claude` (first copy 119 ms, second resolve 1 ms, `copied:false`); a tmux session launched from the copy showed `nlink=1 <retained path>` in `lsof -p <pid> -d txt` BEFORE and AFTER an in-place replacement of the npm `claude.exe` (inode 1647132847 → 1647156230; the old inode was kept linked via a scratch hard link so no existing session was harmed); control: orphaned PID 99502 shows `nlink=0 /claude`.
- Tests: `tests/unit/claude-binary-retainer.test.ts` (25), `tests/unit/session-manager-claude-binary.test.ts` (7), `tests/unit/PostUpdateMigrator-retainedClaudeBinary.test.ts` (5), `tests/integration/claude-binary-route.test.ts` (3), `tests/e2e/claude-binary-lifecycle.test.ts` (3).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is an interaction between an external installer's in-place replacement and the macOS kernel; the fix is runtime code, and the convergence argument for the one self-triggered controller it adds — prune — is: it fires at most once per hour per process, single-flight, bounded to 20 removals per pass, and every gate fails toward keep, so its steady state is "nothing to remove".)

---

## Second-pass review (independent reviewer subagent, 2026-10-14 09:52 PDT)

Audited the artifact against the code and tests. Findings (none blocking): (1) the `--version` fallback for a package.json-less layout ran on every spawn — now cached per source-file identity; (2) the Linux `/proc` mapper check compared an unresolved path — now compares realpath to realpath; (3) `lsof` exit 1 is also returned for an unlocatable file — accepted, since with one explicit file argument that only happens when the file is already gone; (4) the last-used marker was read before the slow mapper probe — now re-read after it; (5) migrator indentation — fixed; (6) artifact said the copy is an APFS clone without requesting one — the copy now passes `COPYFILE_FICLONE`. Verified clean: no spawn-refusal path, never unlinks a mapped file (link + EEXIST, size-suffixed sibling, own-tmp-only cleanup, prune gates), SafeFsExecutor carve-out admits the default dir, process-name matchers (`frameworkProcessSignals`, `frameworkInjectionProcesses`, SessionManager `includes('claude')`) all match the retained `…/claude` argv, signal-vs-authority compliant.

**Concur with the review.**
