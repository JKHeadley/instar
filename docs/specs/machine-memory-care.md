---
title: "Machine memory care: swap counts in machine health, a memory-pressured machine leaves the test line by itself, and Local Verify ends the test processes it leaves behind"
slug: "machine-memory-care"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "machine-memory-care.eli16.md"
status: "approved"
approved: true
approved-by: "Echo, under its standing spec-approval grant (only constitution changes need Justin; this spec changes no constitution text). Reason: it fixes the failure Justin reported in topic 130715 on 2026-11-14 22:06Z (\"We need to do a better job at taking care of our machines\"), filed as Echo Bugs topic 10000002737, and the two review rounds leave no open safety, security or data-loss finding."
approved-at: "2026-11-14T23:01:00.000Z"
review-convergence: "2026-11-14T23:00:53.000Z"
review-iterations: 2
review-completed-at: "2026-11-14T23:00:53.000Z"
single-run-completable: true
---

# Machine memory care

## Problem statement

On 2026-11-14 the M5 Pro (a Local Verify peer) ran out of memory: 17 of 18 GB of swap in use, out-of-memory errors, a garbled screen, and Justin restarted it by hand (topic 130715, 14:06 PST: "We need to do a better job at taking care of our machines"). Three Instar defects let it get there (Echo Bugs topic 10000002737, feedback fb-24668276-141):

1. **Machine health ignored swap.** `machineLoadReport` judged memory by one number, "available memory" (free + inactive + purgeable on macOS). A Mac paging heavily to disk can still show plenty of "available" memory, and macOS often keeps its own pressure level at `normal`. The M5's verdict stayed healthy while it was swapping itself to a standstill.
2. **Local Verify left its test helpers running.** A run's lanes are stopped by process group, but tests start processes that leave the group (detached tmux servers for e2e tests, daemonized helpers). On the M5, 36 helpers sat in a stopped state for up to 18 days: 6.6 GB in 66 processes. The Mac Studio has the same pile today (6 e2e tmux servers and their shells, up to 3 days old).
3. **Nothing took a memory-starved machine out of the test line.** Peer placement skipped a peer only on a `saturated`/`impaired` verdict. Since that verdict could not see swap, the coordinator kept sending the M5 full test runs. The coordinator itself (the Mac Studio) never checks its own memory before starting a run.

The Echo-local 5-minute M5 care check (`.instar/scripts/throughput/m5-care.sh`, topic 130715) is a stopgap for the M5 alone. This spec puts the fix in Instar, for every machine that runs Local Verify, the Mac Studio included.

## Proposed design

### §1 Swap counts in machine health (`src/core/machineLoadReport.ts`)

- The sampler reads swap every 15 s next to its other signals, outside the heartbeat path: macOS `sysctl -n vm.swapusage` (bytes in use) and the `Swapouts:` counter from `vm_stat`; Linux/WSL `/proc/meminfo` (SwapTotal − SwapFree) and `pswpout` from `/proc/vmstat`. An unreadable reading is `null` (missing), never zero.
- `swapActive` = the machine swapped out at a sustained rate, at least 1 MiB/s between two samples (bytes = macOS `Swapouts` × the `vm_stat` page size; Linux `pswpout` × 4096). It is null on the first sample, after a counter reset, or when unreadable. A stray page is not "paging".
- **Swap pressure at a threshold T** = swap in use ≥ T % of physical memory AND live evidence: paging out now (`swapActive`), OR available memory below the existing saturated floor (15 %), OR native pressure `warn`/`critical`. Without live evidence, leftover swap is not pressure. macOS keeps swapped pages until they are touched or the machine restarts, and a healthy Mac routinely reads about 25 % "available" (measured on the Mac Studio, 2026-11-14), so a looser floor would keep a healthy machine out of work until its next restart.
- The verdict's memory row gains swap. The memory pair signal also fires at swap pressure ≥ 10 % of RAM. `impaired` also fires on **swap thrashing**: swap ≥ 25 % of RAM AND `swapActive`. Both still need 2 of the last 3 samples, as every row does.
- The report gains `swapUsedBytes`, `swapActive` and `memoryPressured` (the memory row alone, 2 of 3: CPU and lag never make a machine "memory-pressured"). All three are optional on the wire. The receive clamp passes them only when present, so a report from older code clamps byte-identical and reads as "not pressured" (no change of behaviour for older peers).
- `memoryPressureReason(report)` gives the plain words for notices ("17.0 GB of swap in use (35% of its memory), still paging out"). It is for wording and audit only, never a decision.
- Everything that already reads the verdict (work admission, placement, overload shed, pool readiness) now sees swap through the verdict, with no change to those consumers.

### §2 Local Verify ends what its runs leave behind (`src/localVerify/leftoverReaper.ts`)

What counts as ours is decided by where an ORPHANED process points. A **root** is a process of this user whose parent is gone: it was re-parented to init (pid 1) or to a per-user `systemd --user` subreaper. A detached leftover is an orphan by definition. An agent session whose prompt names a run path, a helper the server spawned, or a developer's own test run in a kept checkout all still have their real parent, so none of them is ever a root. The root must also point into a run folder under a prefix whose age rule it meets. A tmux server qualifies only through its unix socket: the lanes set `TMUX_TMPDIR` inside the run temp folder, and `lsof -U -c tmux` finds the socket. A tmux command line can carry any session's text, so it is never used. Any other process qualifies through its command line. Every live descendant of a root goes with it (a tmux server's pane shells, a stopped worker under its orphaned parent). Never another user, a zombie, init itself, or this process and its ancestors. A leftover gets SIGCONT then SIGKILL, because a stopped process cannot act on SIGTERM.

- **§2a After every run (the run child).** `runVerify`'s `cleanup()`, after every lane has ended and before the folders are removed, reaps processes under that run's own worktree and its own temp folders (`runLeftoverPrefixes`), both `/private/tmp` and `/tmp` spellings. Only that run's folders are named, so nothing of another run, agent or user can match. Audited `leftovers-reaped` in the run log.
- **§2b Backstop (the service).** `cleanup()` does not run when the run child is killed, and piles from older code must go too. At boot, and on the 30 s tick at most every 10 min, the service sweeps:
  - the agent's own run and diagnosis worktrees (`<agentHome>/.worktrees/.verify/runs/`, `…/diagnosis/`), at any age when this service is idle (no run in flight or starting, no blocked orphan record, no peer attempt running, no diagnosis running), else only past the run ceiling;
  - the shared run temp folders (`<tmp>/lv-…`, which another agent's Local Verify on this host may be using right now) only past the run ceiling, always;
  - the run ceiling is 6 hours: no run can last that long (120 min active ceiling plus the preflight), so such a process cannot belong to any live run of any agent.
  - The sweep passes the moment it decided (`startedBeforeMs`): a process that started after that moment (a run that started while the process table was being read) is never taken.
  - Audited `leftovers-reaped` (matched, killed, up to five sample rows) or `leftovers-reap-failed` in `logs/local-verify.jsonl`.

### §3 A memory-pressured machine leaves the test line by itself, with a notice

- **This machine (the coordinator, e.g. the Mac Studio).** A new seam `selfMemoryPressure()` reads the load sampler's `memoryPressure()` (late-bound: the sampler starts after the service). While it returns a reason, `nextRunnableQueuedEntry` starts nothing locally. Hand-offs to healthy peers continue: `scheduleDispatch` runs before that check. A running verify is never cancelled. The next pump after recovery starts the entry; the 30 s tick pumps.
- **Bounded hold.** `main` verifies and replays can run only on the coordinator, so an endless hold would stop merging. After 45 minutes of continuous hold, ONE entry starts, and the next 45-minute window begins when it does. Audited `memory-hold-window-start`.
- **A peer, seen from the coordinator.** `peerFit` (server wiring) returns `{ eligible: false, reason: 'memory-pressure', memoryReason }` when the peer's own FRESH report says `memoryPressured` (`peerMemoryReason`). This holds even when the overall verdict is only `elevated`. A stale or older-code report gives no memory reason, and the existing fit rules decide as before.
- **A peer, on itself.** `peerRun` refuses with `peer-busy` (existing back-pressure: the coordinator offers the PR again later or elsewhere) while its own `selfMemoryPressure()` is set. This covers a coordinator reading a report that is a few seconds old. Audited `peer-run-memory`.
- **The notice.** On entering an episode the coordinator raises `local-verify:memory-pressure:<machineId>` through the existing `hooks.signal` → attention item path (upsert, HIGH, plain-words note saying what to do). The hold lifts as soon as memory recovers. The notice closes through `hooks.clearSignal` only after 10 minutes of fine readings, so a machine that flaps keeps ONE open item instead of a notice per flap. This machine's own reading is evaluated on every tick, so the notice also closes with an empty queue. A peer removed from the peer list reads as fine, so its notice closes. The first fine reading after a restart closes a notice an earlier process may have left open. Only the coordinator raises it: a peer refusing a hand-off raises nothing, so each episode has one voice. Audited `memory-hold` / `memory-hold-cleared`.

### §4 Agent awareness and migration

`MACHINE_MEMORY_CARE_CLAUDE_MD_LINE` is added to the pool section of the CLAUDE.md template, and `migrateClaudeMd` adds it once to existing agents that carry the pool section (marker `Machine memory care (swap counts`).

## Decision points touched

- **Load verdict (signal feeding existing authorities):** the memory row now includes swap pressure. It is a measured signal with a 2-of-3 quorum and a live-evidence requirement, feeding the existing consumers (admission, placement, shed). No new consumer authority is added in §1.
- **Local Verify start admission (modify):** a memory-pressured machine starts no local run. The input is the sampler's quorum reading, not a pattern match. The effect is a wait, never a drop: the entry keeps its place.
- **Peer fit (modify):** a peer whose fresh report says `memoryPressured` is skipped (the same skip shape as `machine-busy`).
- **Peer admission (modify):** `peerRun` returns the existing `peer-busy` back-pressure while memory-pressured.
- **Process reaping (add):** new authority to end processes. It is bounded structurally: orphans of this user only, own folders only, tmux only by socket, never init, self or ancestors, the run-ceiling age floor on shared folders, and a start-time guard against a run that starts during the sweep. Under a test runner (VITEST) a built service gets no real process table unless the test passes one.

## Rollback

Revert the PR. No state format changes: the new report fields are optional, there are no new files on disk, and the attention items close on their own lifecycle. The Echo-local M5 care check keeps working independently either way.

## Open questions

None for the operator. This changes no constitution text.
