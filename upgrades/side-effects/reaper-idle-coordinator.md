# Side-Effects Review — the idle reaper keeps a session waiting on its own background shells

**Version / slug:** `reaper-idle-coordinator`
**Date:** `2026-09-28`
**Author:** `echo`
**Second-pass reviewer:** `required (session lifecycle: the reaper's kill path)`

## Summary of the change

Incident (Mac Studio, 2026-09-28): the 2.0 coordinating session
`echo-deepseek-harness` (topic 52075) was reaped `reaped-idle` at 07:36, 14:32
and 17:24 UTC. `logs/reaper-audit.jsonl` shows tier `normal`
(`normalTierReaps: true`, 45-min threshold) and verdict `reap-eligible / all-clear`
before each reap, never `active-process`. `telegram-messages.jsonl` has no user
message in 52075 between 2026-09-27 and 18:12 UTC on the 28th, so the 8h
stale-idle rule (`reapStaleIdleWithActiveChildren`) was true all day and relaxed
the active-process veto. The live process tree of the revived session showed
what that veto was holding: claude as the pane process, two `/bin/zsh -c source
…/shell-snapshots/snapshot-zsh-….sh … eval '…'` background watch shells, each
with a `sleep 60` child. The relaxation was meant for idle MCP children; it
also discarded the agent's own running commands.

Reaps 1 and 2 were enqueued (`uncommitted-worktree-work`) and revived. Reap 3
was also tagged `midWork: true` but refused by the resume queue's
`resurrection-cap` (2 per window), so it stayed down ~50 min.

Fix:

1. `SessionManager.hasLiveToolShell()` / pure `computeHasLiveToolShell()`:
   true if any descendant of the pane runs a Claude Code tool shell
   (`CLAUDE_TOOL_SHELL_PATTERN = /\/shell-snapshots\/snapshot-/`, in
   `baselineProcessPatterns.ts`). Probe failure ⇒ true.
2. `SessionReaper.evaluate()`: the stale-idle relaxation applies only when no
   tool shell is live, and the cpu-flat relaxation (`cpuAwareActiveProcessKeep`)
   applies to a session with a live tool shell only at `critical` tier (a watch
   loop is CPU-flat by nature; at `moderate` — routine on the Studio during
   builder runs — it would otherwise still reap the coordinator; second-pass
   finding). Probed lazily, once per evaluation, only for a session held by
   `active-process` with a relax pending; a throwing dep ⇒ treated as live
   (keep). `tick()` now passes the tier to `evaluate()`.
3. `SessionReaper.#performReap()`: pre-kill, a live tool shell adds new STRONG
   work evidence `background-shell` (`WorkEvidence.ts`), so a critical-pressure
   reap of such a session is resume-eligible.
4. `computeHasActiveProcesses()`: a direct child of the pane that is a tool
   shell is no longer filtered as "the Claude main process" (its command line
   contains `.claude…/shell-snapshots`, which matched `\bclaude\b`). Without
   this, a background shell between children (no `sleep` running at that
   instant) read as no activity at all.
5. Wiring in `server.ts`; CLAUDE.md template bullet under SessionReaper.

Files: `src/core/SessionManager.ts`, `src/core/baselineProcessPatterns.ts`,
`src/core/WorkEvidence.ts`, `src/monitoring/SessionReaper.ts`,
`src/commands/server.ts`, `src/scaffold/templates.ts`, tests.

### Considered and dropped (Occam)

- **Raising the resurrection cap.** It is the brake on kill-revive loops, and
  with the keep fix the normal idle path no longer kills this session, so the
  cap is not reached. Not changed.
- **Exempting tool shells from the cpu-flat relaxation at every tier.** That
  would pin such sessions even at `critical` pressure. The brief asks that
  pressure reaping still work, so `critical` keeps the relax and the revive
  evidence covers it.
- **Reusing `active-process` as the evidence.** It is WEAK (one idle MCP child
  games it), so alone it never queues a revive. A tool shell is the agent's
  own command, which is direct evidence of in-flight work; a new strong value
  is the smallest honest signal.

## Decision-point inventory

- `SessionReaper.evaluate()` stale-idle relaxation: modified, can only KEEP more.
- `computeHasActiveProcesses()` main-process filter: modified, can only report
  active more often (every consumer treats active as keep / don't-kill).
- `WorkEvidence` STRONG set: one value added; affects only resume eligibility.

## 1. Over-block

A silent-topic session with a forgotten long-running background command (a dev
server, a `tail -f`) is now kept at `normal` / `moderate` tier where it was
reaped before. At `critical` pressure the cpu-flat relaxation still reaps it
(if the command is CPU-flat), and it is then revived at most
`maxResurrections` (2) times per window. At `moderate`, a CPU-flat forgotten
command now pins the session too (it did not before, on agents with
`cpuAwareActiveProcessKeep`). A CPU-busy forgotten command was already un-reapable before
this change (active-process holds). Accepted: the reaper's contract is "never
reap a session that might be working", and a running command is that.

The `computeHasActiveProcesses` change also affects the other callers
(age-limit gate, idle-prompt kill, UpdateGate job check): they now see a
direct-child tool shell as active. Before, they saw it only through its
children, which a watch loop almost always has; the difference is the short
window between children. More keep, never less.

## 2. Under-block

- Codex / Gemini sessions: their shells do not use `shell-snapshots`, so this
  signal is claude-code only. The coordinator is claude-code.
- A session waiting on work in OTHER tmux sessions without any shell of its own
  (just idle at the prompt) is still reaped after 8h of topic silence. Nothing
  local can see that dependency; the brief's case always had watch shells.
- Claude Code could change its shell-snapshot path; the test fixture is the
  real captured command line, so a change shows up as a failing detection, and
  the fallback is today's behavior (not worse).

## 3. Level-of-abstraction fit

The signal sits beside the existing process probes in `SessionManager`, and the
decision stays in the reaper's existing relaxation branch. The shared
`ReapGuard` is untouched: its `active-process` guard already keeps these
sessions; only the reaper's own stale-idle override was wrong.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

It narrows an existing kill relaxation (fewer kills) and adds a revive signal
consumed by the existing resume queue eligibility classifier.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The change is a
safety guard on an irreversible action (a kill): "the agent's own command is
still running" is an enumerable fact, and it resolves to keep.

## 5. Interactions

- **Shadowing:** runs only inside the existing `active-process` relaxation
  branch; every earlier guard still wins first. The `cpu-keep-tightened` audit
  row now appears only when the relax actually applied.
- **Double-fire:** the reap path's `bypassActiveProcessKeep` is now false when
  stale-idle was blocked by a shell, so the terminate authority re-checks
  active-process as before.
- **Races:** the shell may exit between `evaluate()` and `#performReap()`; then
  the evidence is simply absent (same as today). Hysteresis and the two-phase
  grace are unchanged.
- **Feedback loops:** `background-shell` evidence can revive a pressure-reaped
  session that is then reaped again; the resume queue's resurrection cap bounds
  that (unchanged).

## 6. External surfaces

No routes, messages or persistent schema change. `reap-log` / resume-queue rows
may now carry `background-shell` in `workEvidence` (the chokepoint clamp accepts
it because it is in the enum). No operator-facing actions.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the reaper judges processes on its own machine; the
process tree cannot be seen from a peer. No notices, no durable state beyond
the existing per-machine reap-log/resume-queue rows, no URLs.

## 8. Rollback cost

Pure code change — revert and ship a patch. `background-shell` rows already in
a resume queue would be dropped by the clamp after a rollback (unknown names are
dropped), which only means such an entry is no longer eligible. The existing
kill switch `reapStaleIdleWithActiveChildren: false` is unaffected.

## Conclusion

The reaper's 8h stale-idle override (and, at moderate load, its cpu-flat
override) treated a coordinator's own running watch loops like idle plugin
servers. It now keeps a session while one of its tool shells runs, below
critical pressure; reports such a shell as strong evidence when critical
pressure still forces a reap; and the process probe no longer hides direct-child tool shells. Only
keeps are added. Clear to ship after second-pass review.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (round 1)
**Independent read of the artifact: concur**

Concurred: only keeps are added, probe failures keep, genuinely idle sessions
are still reaped, and revives stay bounded by the resurrection cap. Other
`computeHasActiveProcesses` callers all read "active" as keep/defer; nothing
else enumerates evidence values. Non-blocking notes, and what was done:

1. At `moderate` CPU load on dev agents (`cpuAwareActiveProcessKeep`), the
   cpu-flat relax could still reap the coordinator. **Fixed in this PR**: a
   live tool shell blocks that relax below `critical` (tests both sides).
2. PresenceProxy's tier-3 process filter in `server.ts` also drops a
   direct-child tool shell via `\bclaude\b`. Not touched: it decides a
   standby status message, not a kill, and is not part of this incident.
3. The new CLAUDE.md bullet reaches new agents only; this matches how every
   other SessionReaper bullet shipped (no `migrateClaudeMd` step for them).

## Evidence pointers

- `tests/unit/session-reaper.test.ts` → "a session waiting on its own
  background shells is not abandoned": stale topic + live shell ⇒ KEEP
  (evaluate and 6 ticks at normal tier); probe throws ⇒ KEEP; stale + only idle
  children ⇒ still reaped (`bypassActiveProcessKeep: true`, no evidence);
  genuinely idle ⇒ reaped with no evidence; moderate + cpu-flat + live shell ⇒
  never reaped, moderate + cpu-flat + no shell ⇒ reaped; critical + cpu-flat +
  live shell ⇒ reaped WITH `background-shell`. Four of these fail on origin/main.
- `tests/unit/SessionManager-live-tool-shell.test.ts`: the real captured ps
  tree ⇒ shell detected; MCP-only ⇒ not; another pane's shell ⇒ not;
  `computeHasActiveProcesses` counts a lone direct-child tool shell (fails on
  origin/main) while still filtering claude and MCP.
- `tests/unit/work-evidence.test.ts`: `background-shell` survives the clamp and
  is eligible alone.

## Class-Closure Declaration (display-only mirror)

The change modifies a self-triggered controller (the SessionReaper) only by
removing kill cases and adding a revive evidence value. Convergence: kills are
a subset of before; revives remain bounded by the unchanged resume-queue
resurrection cap (`maxResurrections`, default 2) and its one-per-minute drain.
No agent-authored-artifact defect — not applicable.
