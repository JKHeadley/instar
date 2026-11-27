# Side-Effects Review: machine memory care (swap counts, memory-pressured machines leave the test line, Local Verify ends its leftovers)

**Version / slug:** `machine-memory-care`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (two rounds; see "Second-pass review" below)`

## Summary of the change

Bug: Echo Bugs topic 10000002737, feedback fb-24668276-141. The M5 ran out of memory (17 of 18 GB swap) while Instar called it healthy and kept sending it full test runs, and Local Verify had left 66 helper processes (6.6 GB) running on it for up to 18 days. Spec: `docs/specs/machine-memory-care.md`.

What changes:
- `src/core/machineLoadReport.ts`: the sampler reads swap in use and a sustained swap-out rate. Swap with live evidence joins the verdict's memory row. The report gains `swapUsedBytes`, `swapActive` and `memoryPressured`.
- `src/core/machineResourceProfile.ts`: `peerMemoryReason`.
- `src/localVerify/leftoverReaper.ts` (new): pure selection plus the real `ps`/`lsof` readers.
- `src/localVerify/orchestrator.ts` and `orchestratorSeams.ts`: an end-of-run reap of the run's own folders.
- `src/localVerify/LocalVerifyService.ts`: a memory hold on local starts (bounded), a memory refusal in `peerRun`, the memory notice lifecycle, and the backstop sweep at boot and every 10 minutes.
- `src/localVerify/localVerifyWiring.ts` and `src/commands/server.ts`: the seams, the peer fit and the notice mapping.
- `src/core/PostUpdateMigrator.ts` and `src/scaffold/templates.ts`: one CLAUDE.md awareness line.

Tier 2: new authority to end processes, and a modified start gate.

Size: about 900 lines changed or added across 10 source files and 6 test files. Effort: two review rounds.

## Decision-point inventory

- Load verdict memory row (`deriveLoadVerdict`): **modify**. Swap pressure (swap ≥ 10 % of RAM with live evidence) joins the memory pair signal. Swap thrashing (≥ 25 % of RAM and sustained paging) joins `impaired`. This is a measured signal with a 2-of-3 quorum. It feeds the existing consumers unchanged: work admission, placement, overload shed, pool readiness.
- Local Verify local start (`nextRunnableQueuedEntry`): **modify**. No local start while this machine is memory-pressured, bounded to one start per 45 minutes.
- Local Verify peer fit (`peerFit` in `server.ts`): **modify**. A fresh `memoryPressured` report makes the peer ineligible.
- Local Verify peer admission (`peerRun`): **modify**. It refuses with the existing `peer-busy` back-pressure while memory-pressured.
- Leftover reaping (`reapLeftovers`): **add**. New authority to SIGKILL processes, bounded as described in §1 to §5.
- Memory notice (`hooks.signal` / `clearSignal`): **add**. A new attention-item key family.

---

## 1. Over-block

- **The verdict could be wrong for a machine with leftover swap.** That was the first review's finding, and it is fixed. Leftover swap counts only with sustained paging (≥ 1 MiB/s), under 15 % available memory, or OS pressure. The healthy Mac Studio's normal ~25 % "available" no longer qualifies. Residual: a machine doing a short burst of real paging (≥ 1 MiB/s for 2 of 3 samples, about 30 s) while holding ≥ 10 % of RAM in swap reads memory-pressured during the burst. That is a correct reading. Its cost is that Local Verify starts wait for that window.
- **Work admission now also closes on swap thrashing (`impaired`).** This is intended: a thrashing machine should take no new automatic work. On the fleet, admission ships dev-gated and dry-run (`monitoring.workAdmission`), so the effect there is a log line until it is enforced.
- **The coordinator's self-hold could stall `main` verification.** Bounded: one start per 45-minute window.
- **The reaper could take a process a user wants.** Only orphans of this user that point into Local Verify's own folders, or that run under such an orphan. A live session or a hand-run test has its real parent and is never a root. Residual: a user who deliberately daemonizes a process from inside a Local Verify run folder (`nohup … &` in a kept checkout, then closes the shell) gets it reaped at the next idle sweep. That is acceptable: those folders belong to the verifier.

## 2. Under-block

- **Shared `/tmp/lv-…` leftovers of a killed run wait up to 6 hours.** This is deliberate, because another agent's live run may share the folder. The end-of-run reap catches the normal case at once. On the M5 the pile was 18 days old, so 6 hours is a large improvement, not the floor of what is possible.
- **tmux servers are found only through `lsof`.** On a Linux host without `lsof`, orphaned tmux servers are not reaped. Their command-line leftovers (pane shells under them) are not either, because they are not orphans. Recorded in the spec's Linux posture. macOS always has `lsof`.
- **Non-Instar memory hogs are not touched.** On the M5 these were Chrome and old Claude sessions. This change only takes the machine out of the line and says so. The notice tells the operator what to do. The Echo-local care check and the throughput session handle the human conversation about other apps.
- **A machine whose report is older than 60 s** reads `unknown`. The existing fit already excludes it (`load-unknown`), so there is no gap.

## 3. Level-of-abstraction fit

Swap belongs in the load report: it is the one place every machine's health is measured, and every consumer already reads the verdict from it. Adding swap there fixes admission, placement and readiness together, instead of teaching each consumer to read swap.

The test-line policy stays in Local Verify, which owns the line. It consumes the sampler's quorum reading through a seam and does not re-measure.

The reaper sits inside Local Verify because ownership is defined by Local Verify's own folders. A general process reaper would have no ownership rule to rest on. The existing `sweepOrphanVerifyRuns` removes run folders, not processes, so it does not overlap.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`.
- **Swap detector:** measured numbers with a quorum and a live-evidence requirement. It holds no authority of its own; it feeds the existing verdict consumers.
- **Start hold:** consumes that quorum signal. It never drops work (an entry keeps its place) and is time-bounded.
- **Reaper:** a narrow authority, structurally scoped. It needs process-table facts (uid, orphan status, a socket path inside our folder, age), not a judgment call or a text pattern on free content. The first review found the original command-line match too brittle for kill authority (an agent prompt could name a path), and the orphan requirement removes that. tmux is matched by socket only for the same reason.
- `memoryPressureReason` (text) is wording only. Nothing decides on it.

## 5. Interactions

- **The existing group kill in `onExit`/`cancelInFlight` and `reapOrphan`:** they run first. The new reap covers what escaped the group. No double-kill harm, because SIGKILL of a gone pid is ignored.
- **`sweepOrphanVerifyRuns` (folder removal):** it runs at the run child's start. Reaping processes first means fewer folders read as "in use".
- **The failed-file diagnosis service:** `localIdle()` treats a busy diagnosis as busy, and diagnosis folders are a separate prefix with the same rule.
- **Focused preflight:** it runs inside the run child, so its processes exist only while a run is in flight (not idle). Its `lv-` temp folders are shared-prefix, so the 6-hour rule applies.
- **The Echo-local `m5-care.sh` (topic 130715):** it keeps flipping `peer.enabled` on the M5 by its own rules. The two never fight: the in-product hold reads memory and does not change config, and the script's leftover kill uses a broader pattern that this reap makes mostly redundant. It can be retired once this is installed on the M5.
- **Work admission's recovery slot and overload shed:** unchanged code. They see swap only through the verdict.

## 6. External surfaces

- `GET /pool` rows gain three optional `loadReport` fields. Older readers ignore them; older senders omit them and clamp byte-identical.
- One new attention-item family (`local-verify:memory-pressure:<machineId>`), raised only by the lease-holding coordinator.
- One CLAUDE.md line, added to the template and migrated once to existing agents.
- Timing dependence: sampler cadence (15 s), tick (30 s), sweep (10 min). None changes an existing interval.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Swap measurement:** machine-local by nature, and replicated through the existing heartbeat load report, which the receive clamp handles.
- **Test-line decisions:** the coordinator decides from peers' replicated reports, and each peer protects itself in `peerRun`. One voice for notices: the coordinator alone.
- **Reaping:** machine-local by design (it ends this machine's own processes). It runs on every Local Verify machine, the Mac Studio and the M5 alike.
- **Notice state:** in memory on the coordinator, and not replicated. On a lease move, the new coordinator raises its own episode notices. The old coordinator's notices close on their lifecycle, or on the first fine reading after its restart.

## 8. Rollback cost

Revert the PR and ship a release. There is no data migration: the new wire fields are optional, and no new state files are written. Open attention items expire on their own lifecycle. The CLAUDE.md line stays as harmless text unless a follow-up migration removes it.

## Second-pass review

**Reviewer:** independent reviewer subagents, two rounds (a fresh reviewer each round, given the code, not the author's conclusions)

Round 1 (independent subagent) raised a concern with 7 findings:
1. Command-line matching could kill agent sessions. Fixed: orphan roots only, tmux by socket only.
2. The swap rule false-positived on the healthy Studio's ~25 % available memory, and the hold could wedge `main`. Fixed: a sustained rate, the 15 % floor, impaired only on thrashing, and the bounded hold.
3. Kept-failed checkouts were not protected. Fixed by the orphan rule.
4. `localIdle` missed `blockedBy`, and the host-quiet check was unreliable. Fixed: `blockedBy` counts as busy, and shared temp folders always use the 6-hour rule.
5. Notice lifecycle gaps. Fixed: per-tick evaluation, the 10-minute close, removed peers close, and the boot close.
6. Diagnosis folders were not covered. Fixed.
7. A wrong migration test. Fixed.

Round 2 (a fresh independent subagent, given the code and the list of round-1 fixes to verify) confirmed every round-1 fix holds. It found 5 new items, all fixed:
1. **Blocking, a test defect:** the real-process integration test spawned a helper that was not an orphan, so it would fail, and the start-time case passed vacuously. Fixed with a double fork plus a wait for ppid 1. The start-time case now proves that the guard, not the orphan rule, kept the process.
2. **Wrong numbers in the CLAUDE.md line** (30 % and an unconditional 25 %). Fixed to 15 % and "25 % while still paging".
3. **More than one voice.** A non-lease-holder with a source checkout could raise notices. Fixed: only the lease holder raises or closes notices; its own start hold still applies.
4. **Silent gap with no lsof.** Fixed: a missing binary reads as unreadable (not as an empty answer), and an audit row `leftovers-tmux-sockets-unreadable` is written once per process.
5. **A test right by coincidence** (exactly at the rate threshold). Fixed with a clear margin.

Findings fell from 7 (three of them design-level) to 5 (one blocking, and that one a test defect). No design concern remains, so convergence is reached.

Verdict: Concur, after the round-2 fixes.

After review, the first full Local Verify run found two guard tests failing, and both are fixed. The three sampler reads that report an unreadable signal as null now carry the `@silent-fallback-ok` reason, which is what `no-silent-fallbacks` checks for. The `ps` call in `leftoverReaper.ts` now passes `maxBuffer` where it is called, which `ps-table-max-buffer` checks. Behaviour is unchanged.

## Class-Closure Declaration (display-only mirror)

- **Class:** `unbounded-self-action`. **Closure:** `guard`, enforced by the ratchet in `tests/unit/self-action-convergence.test.ts`.
- **`local-verify-leftover-reaper`** (registered in `src/testing/selfActionRegistry.ts`). It kills each orphaned leftover once: a killed pid leaves the process table, and the sweep starts no processes. Emissions are bounded by the finite pool of leftovers (K=3 in the fixture, 1 per pid), at a 10-minute cadence. A live run's process is never selected.
- **`local-verify-memory-notice`.** A notice opens once per episode and closes only after 10 minutes of fine readings. A sustained or flapping episode yields one notice (K=1).
