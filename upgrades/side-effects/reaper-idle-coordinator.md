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
   `baselineProcessPatterns.ts`). Probe failure (tmux or ps cannot run) THROWS:
   an unreadable tree is unknown, not an observed shell (round 2, Astra).
   The reaper's keep wrapper reads a throw as "keep"; the evidence collector
   reads it as "omit".
2. `SessionReaper.evaluate()`: below `critical` tier, neither the stale-idle
   relaxation nor the cpu-flat relaxation (`cpuAwareActiveProcessKeep`) applies
   to a session with a live tool shell (a watch loop is CPU-flat by nature; at
   `moderate` — routine on the Studio during builder runs — it would otherwise
   still reap the coordinator; second-pass finding). At `critical` both
   existing relaxes stay available whatever the shell signal reads (live or
   unknown), independent of the CPU feature flag — the emergency reclaim path
   (round 2, Astra: the fleet default has `cpuAwareActiveProcessKeep` off, so
   without this a live shell pinned the session even at critical). Probed
   lazily, once per evaluation, only for a session held by `active-process`
   with a relax pending below critical; a throwing dep ⇒ treated as live
   (keep). `tick()` now passes the tier to `evaluate()`.
3. `SessionReaper.#performReap()`: pre-kill, a live tool shell adds new STRONG
   work evidence `background-shell` (`WorkEvidence.ts`), so a critical-pressure
   reap of such a session is eligible for revival, subject to the resume
   queue's existing gates and cap. A throwing probe omits the signal.
4. `computeHasActiveProcesses()`: a direct child of the pane that is a tool
   shell is no longer filtered as "the Claude main process" (its command line
   contains `.claude…/shell-snapshots`, which matched `\bclaude\b`). Without
   this, a background shell between children (no `sleep` running at that
   instant) read as no activity at all. A tool shell also wins over the
   baseline-pattern exclusion (round 2, Astra): its command text may merely
   mention `caffeinate`, `mcp-stdio-entry`, or another baseline name, and was
   discarded as noise, so the relax branch was never entered.
5. Wiring in `server.ts`; CLAUDE.md bullet under SessionReaper, shared by the
   template and a content-sniffed `migrateClaudeMd` step for existing agents.

Files: `src/core/SessionManager.ts`, `src/core/baselineProcessPatterns.ts`,
`src/core/WorkEvidence.ts`, `src/monitoring/SessionReaper.ts`,
`src/commands/server.ts`, `src/scaffold/templates.ts`,
`src/core/PostUpdateMigrator.ts`, tests.

### Considered and dropped (Occam)

- **Raising the resurrection cap.** It is the brake on kill-revive loops, and
  with the keep fix the normal idle path no longer kills this session, so the
  cap is not reached. Not changed.
- **Exempting tool shells from the cpu-flat relaxation at every tier.** That
  would pin such sessions even at `critical` pressure. The brief asks that
  pressure reaping still work, so `critical` keeps both relaxes and the
  evidence makes the session eligible for revival (subject to the queue's cap).
- **Reusing `active-process` as the evidence.** It is WEAK (one idle MCP child
  games it), so alone it never queues a revive. A tool shell is the agent's
  own command, which is direct evidence of in-flight work; a new strong value
  is the smallest honest signal.

## Decision-point inventory

- `SessionReaper.evaluate()` stale-idle relaxation: modified, can only KEEP more.
- `computeHasActiveProcesses()` main-process and baseline filters: modified,
  can only report active more often (every consumer treats active as keep /
  don't-kill).
- `WorkEvidence` STRONG set: one value added; affects only resume eligibility.

## 1. Over-block

A silent-topic session with a forgotten long-running background command (a dev
server, a `tail -f`) is now kept at `normal` / `moderate` tier where it was
reaped before. At `critical` pressure the stale-idle relaxation (and, with the
CPU flag on, the cpu-flat one) still reclaims it, and it is then revived at most
`maxResurrections` (2) times per window. There is no absolute age bound below
critical: the age gate defers to the (now true) activity probe. Accepted
residue — an arbitrary normal-tier TTL would recreate this outage for
legitimate long work. At `moderate`, a CPU-flat forgotten
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
- Claude Code could change its shell-snapshot path. The test fixture is a
  hard-coded captured command line, so it cannot detect a future upstream
  format change by itself; if the path changes, detection silently stops and
  behavior falls back to today's (not worse).
- The signal is a path substring: a resident command whose arguments merely
  mention a snapshot path reads as a live shell. It proves the agent's own
  command is running, not that it makes useful progress.

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
  the evidence is simply absent (same as today). A probe that cannot inspect
  the tree at evidence time throws and the signal is omitted — unknown is
  never recorded as strong evidence. Hysteresis and the two-phase
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
critical pressure; keeps the existing reclaim at critical pressure (live or
unknown shell, CPU flag on or off); reports an observed shell as strong
evidence when critical pressure forces a reap; and the process probe no longer
hides tool shells behind the Claude-main or baseline filters. Below critical
only keeps are added. Clear to ship after second-pass review.

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
3. The round-1 claim here — that no other SessionReaper bullet was migrated —
   was false: `migrateClaudeMd` already carries a SessionReaper CPU-aware +
   decision-audit section. **Fixed in round 2**: the bullet now reaches
   existing agents through `migrateClaudeMd` (content-sniffed on its marker,
   inserted before the busy-orphan bullet or appended; idempotent).

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
- Round 2 (Astra CHANGES REQUIRED):
  - `SessionManager-live-tool-shell.test.ts`: a tool shell whose command
    mentions `caffeinate` / `mcp-stdio-entry` counts as active (fails before
    the fix); MCP servers + a bare `caffeinate` stay baseline; the production
    `hasLiveToolShell` THROWS when tmux cannot be queried.
  - `session-reaper.test.ts` → "critical pressure keeps its stale-idle escape":
    CPU flag off; normal and moderate KEEP a live shell and an unknown shell
    (the production `SessionManager.hasLiveToolShell` with a failing tmux);
    critical reclaims a live shell WITH `background-shell` and an unknown one
    WITHOUT evidence; another keep guard (active subagent) still holds at
    critical.
  - `tests/integration/reaper-live-tool-shell-real-tmux.test.ts`: each pane's
    creation is asserted, the between-children shell blocks on an open fifo
    (`read x <> fifo`), the intended process shape is asserted through `ps`
    before any probe result, and a vanished session makes the probe throw.
  - `PostUpdateMigrator-reaperBackgroundWorkBullet.test.ts`: insertion before
    the busy-orphan bullet, append fallback, idempotency, and revival wording.
  - Architecture check: `node scripts/check-architecture.mjs` is a 2.0 script
    absent from 1.x; the 1.x equivalent `npm run lint` exits 0 on this tree.

## Class-Closure Declaration (display-only mirror)

The change modifies a self-triggered controller (the SessionReaper) only by
removing kill cases and adding a revive evidence value. Convergence: kills are
a subset of before below critical (at critical the pre-existing relaxes are
unchanged); revives remain bounded by the unchanged resume-queue
resurrection cap (`maxResurrections`, default 2) and its one-per-minute drain.
No agent-authored-artifact defect — not applicable.
