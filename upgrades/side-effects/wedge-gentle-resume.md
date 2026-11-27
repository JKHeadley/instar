# Side-Effects Review — wedge gentle rung: resume launches LaunchServices left stopped

**Version / slug:** `wedge-gentle-resume`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Machine self-maintenance Part E, CMT-1202, first acting slice: the gentle rung on macOS. On the Mac Studio on 2026-11-16, every GUI launch for about 20 hours was spawned and then left stopped (STAT T), and `kill -CONT` freed each one. #3248 made the wedge canary detect this: `canary-left-stopped`.

What this adds: when a sample reads its own canary left stopped, `WedgeMonitor.gentleRung` lists this user's stopped launches. It reads them with a new read-only `ps -axo pid=,uid=,ppid=,stat=,etime=,comm=` and selects with `parseStoppedLaunches`. A launch is listed only when it is:
- in state T and owned by this uid;
- parented by launchd (ppid 1);
- at least 60 seconds old;
- an app's own `X.app/Contents/MacOS/X` (not nested) under `/Applications`, `/System/Applications`, `/System/Library/CoreServices` or `~/Applications`;
- not the canary.

With the setting `machineMaintenance.wedgeRestart.gentleResume` at `on`, it sends each listed launch SIGCONT through the injected `resumeStopped`, at most 20 per sample and 2 per pid per server run. At `dry-run` (the default) it records what it would resume and sends nothing. At `off` it does not read. Each run is audited as `wedge-gentle`, and the last run is shown at `GET /machine-maintenance` → `wedge.lastGentle`, with the mode in `wedge.gentleResume`. The spec gains a "Rung 0" paragraph in Part E.

Files:
- `src/monitoring/machineMaintenance/{readings,WedgeMonitor}.ts`
- `src/commands/server.ts`: wiring of `resumeStopped` and `home`
- `src/testing/selfActionRegistry.ts`: new entry
- `docs/specs/machine-self-maintenance.md`
- tests: unit, route, e2e, and the watch-only pins

## Decision-point inventory

- The gentle rung: **add**. A new deterministic action: resume a stopped launch on direct evidence.
- `readF1`: **pass-through**. Unchanged.

---

## 1. Over-block

No block/allow surface. A launch that someone stopped on purpose could be resumed, for example with a tool that pauses background apps. Three things limit this:
- the rung runs only while LaunchServices is stopping launches, so the canary is stopped in that same sample;
- launchd must be the parent, so shell job control (Ctrl-Z) is never touched;
- each pid is resumed at most twice, so a tool that re-stops an app is not fought.

---

## 2. Under-block

These stopped processes are not resumed:
- a helper whose parent is the app, not launchd;
- an app outside the known folders;
- a launch under a minute old.

The last one is deliberate, because such a launch may still be starting. All of them stay for the later rungs, or for the owner's Restart now.

---

## 3. Level-of-abstraction fit

The rung lives in the monitor, the component that already holds the evidence, the sampler cadence and the probe runner. It sits next to the canary cleanup from #3248. The signal itself goes through an injected dependency, `resumeStopped`, wired only in `server.ts`, and the watch-only test pins that wiring to its exact text.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No: this change produces a signal consumed by an existing smart gate.

The F1 evidence and the judge are unchanged. The rung is not a judgment between competing signals. "Our own canary was just left stopped, and these app launches of this user are stopped too" is direct, enumerable evidence. SIGCONT is the least possible action: it continues a process and cannot end one. The spec's ladder entry points for rungs 1–7 remain the judge's; rung 0 needs no judge, the same way the canary cleanup in #3248 needs none.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no new static heuristic at a decision point with competing signals. The selection rules are floors: uid, parent, age and folder. The setting ships `dry-run`, so the rung's record of what it would have resumed is the evidence for turning it on.

---

## 5. Interactions

- **Canary cleanup:** the canary is excluded by its path tail. It is still ended, never resumed.
- **Double-fire:** only the host's wedge maintainer samples, single-flight, so one agent per login acts.
- **Races:** a process that exits between the read and the signal makes `process.kill` throw. That counts as `failed`, which is harmless.
- **Feedback loop:** a resumed launch does not change the canary's own reading. F1 stays positive until the GUI path heals, so the rung runs again at the 2-minute positive cadence, bounded by the per-pid cap.

---

## 6. External surfaces

- Other users' processes are never read past their uid, and never signalled.
- Two new fields in `GET /machine-maintenance` → `wedge`: `gentleResume` and `lastGentle`. `lastGentle` holds app names and pids only, never arguments or window titles.
- No new durable state. The per-pid count is in memory.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing action; the reading is status only. Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

This is **machine-local by design**: a GUI launch path and its stopped processes belong to one machine's session (`hardware-bound-resource`). The pool view already carries each machine's wedge block.

---

## 8. Rollback cost

Rolling back is either the setting (`gentleResume: off`), which is live with no restart, or a code revert. No persistent state.

---

## Conclusion

This is the first acting rung of wedge recovery, and the least invasive one possible. It is scoped to the evidence that showed the problem on the Studio, and it ships dry-run. Tier 2, because it adds the authority to signal a process outside the feature's own probe. Clear to ship.

---

## Evidence pointers

- The brief (2026-11-16): "SIGCONT stopped launches from known paths" as the gentle rung before restart; on the Studio, `kill -CONT` freed the stuck launches.
- Tests: `tests/unit/machine-wedge-gentle-rung.test.ts`, `tests/integration/machine-wedge-route.test.ts`, `tests/e2e/machine-wedge-lifecycle.test.ts`, `tests/unit/machine-maintenance-watch-only.test.ts`, `tests/unit/self-action-convergence.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard`. Registered as `machine-wedge-gentle-resume` in `src/testing/selfActionRegistry.ts` (bound: 2 per stuck launch, 20 per sample), proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet).
- **How caught:** each stuck launch is resumed at most twice per server run, at most 20 per sample, only while the canary itself is left stopped, and at the sampler's single-flight 2-minute floor.
