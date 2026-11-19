# Side-Effects Review — wedge canary: a stopped canary is a failure, and leftovers are ended

**Version / slug:** `wedge-canary-left-stopped`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Machine self-maintenance Part E (dry-run wedge detection), family F1 on macOS. The probe runs `open -g -j` of the shipped no-UI canary and counted exit 0 as a pass. On the Mac Studio on 2026-11-16, during a live GUI-launch wedge, `open` exited 0 while LaunchServices left the canary stopped (STAT T) and it never ran, so F1 read `canary-passed` at 17:29Z; and every launch left one more stopped canary (11 piled up over 20 h, fb-92ed1f8b-3a2). Now: before each launch the monitor lists this user's canary processes (`ps -axo pid=,uid=,stat=,args=`, matched on the canary executable's exact path tail) and ends any leftover with SIGKILL; after the launch it waits 2 s, reads the table again, and passes `canaryLeftover` to `readF1`. Exit 0 with a stopped canary is now the failure `canary-left-stopped` (same eligibility rules as any F1 failure); exit 0 with an unread table is `unknown` (`canary-exit-unread`); a canary still running but not stopped is `unknown` (`canary-still-running`). A stopped canary is ended right after the read. Files: `src/monitoring/machineMaintenance/{readings,wedgeEvidence,WedgeMonitor}.ts`, `src/commands/server.ts` (wiring), `tests/unit/machine-wedge-mac-canary.test.ts`. Also records round 10 of the spec review (round 9's three fixes read, CLEAR) in `docs/specs/reports/machine-self-maintenance-convergence.md`.

## Decision-point inventory

- `readF1` (F1 verdict, macOS) — modify — exit 0 no longer passes alone; the process table must show the canary gone.
- Ending a leftover canary — add — the monitor ends this user's own stuck wedge-canary processes, nothing else.

---

## 1. Over-block

No block/allow surface. F1 can now read positive where it read negative before, only when this probe's own canary is in state T two seconds after `open` returned; that is the observed wedge itself. A slow but healthy machine whose canary is still running (not stopped) reads `unknown`, not positive.

---

## 2. Under-block

A canary that LaunchServices never spawns at all while `open` still exits 0 would read as gone, so as a pass. Not observed; the observed failure always left a T-state process. The capture half of F1 is still not wired (unchanged).

---

## 3. Level-of-abstraction fit

Right layer: the evidence reading itself was wrong, so the fix is in the reading (`readF1`) and its probe, not in the judge or the window. Process listing reuses the existing read-only call table and probe runner.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

F1 is evidence for the wedge window and the `machineWedgeJudge`; nothing here decides a restart (wedge restart remains dry-run with no rung built). The one action added, ending a leftover canary, is a deterministic cleanup of this feature's own probe process, identified by exact executable path tail and this user's uid; it is not a decision with competing signals.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is our own no-UI canary still present after it should have quit" is enumerable: the canary has no work and quits at once by construction.

---

## 5. Interactions

- **Shadowing:** none; F2/F4 readings untouched.
- **Double-fire:** only the host's wedge maintainer samples, single-flight, so one agent ends canaries per login. Another agent install's canary (same tail, same uid) is ended too, deliberately: any surviving canary is stuck, whichever install launched it.
- **Races:** the pre-launch reap runs before the launch in the same sample, so it never ends this sample's canary. A concurrent maintainer takeover could in theory launch a canary between the reap and the read; the worst case is one sample reading `canary-left-stopped` for a canary that was merely mid-start in state T, which the 20-minute three-observation window absorbs.
- **Feedback loops:** none. Ending a stopped process does not affect the next launch's outcome.

---

## 6. External surfaces

- Other agents on the machine: their stuck canaries (same user) are ended; nothing else of theirs is read or touched.
- Persistent state: none new. Audit lines carry two new numeric details (`canariesLeftStopped`, `canariesEnded`).
- Operator surface: no operator-facing actions. The reading is visible in `GET /machine-maintenance` under `wedge` (this also answers the feedback's second ask: the wedge reading already has a documented route there).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: a GUI launch path and its stuck processes are this machine's hardware/session truth (`hardware-bound-resource`). The pool question is already answered by `GET /machine-maintenance?scope=pool`. No notices, no URLs, no new durable state. No status surface changes shape.

---

## 8. Rollback cost

Pure code change; revert and ship a patch. No persistent state. During rollback the canary pile-up returns on a wedged Mac.

---

## Conclusion

A real, live-observed false pass in the wedge evidence is closed, and the process leak it caused is stopped. Wedge detection stays dry-run; no restart path exists in this change. Clear to ship. Tier 2 because it adds the authority to end a process, scoped to the feature's own canary.

---

## Evidence pointers

- Live: Mac Studio 2026-11-16, `ps` at 09:44 PST showed pid 51709 `InstarWedgeCanary` in state T, started 09:29:48, the same minute F1 logged `canary-passed` (17:29:48Z) in `logs/machine-maintenance.jsonl`.
- Unit: `tests/unit/machine-wedge-mac-canary.test.ts` (stopped leftover is positive and ended; earlier leftovers ended before launch; unread table is unknown; running-not-stopped is unknown; parser excludes other users, editors and grep).

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — registered as `machine-wedge-canary-reap` in `src/testing/selfActionRegistry.ts`, an Eternal Sentinel proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet).
- **How caught:** it ends only the canary its own sample launched, one per sample, each pid once, at the sampler's single-flight 2-minute floor; a cleared wedge or a new boot stops it.
