# Side-Effects Review — Machine wedge detection, dry-run (Part E)

**Version / slug:** `machine-wedge-dryrun`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `coordinator's reviewer — concern raised, fixed, re-check concurred (2026-11-03 00:52 PST) (see the Second-pass review section)`

## Summary of the change

Implements the dry-run half of Part E of `docs/specs/machine-self-maintenance.md` (CMT-1202). A new `WedgeMonitor` (`src/monitoring/machineMaintenance/WedgeMonitor.ts`) samples the evidence families (F1 GUI path, F2 process table, F4 agent symptoms; F3 reported `not-covered`) every 10 minutes, every 2 while any is positive, through four new fixed entries in the read-only command table (`readings.ts`: `ps -axo stat=`, `systemd-run --user … /bin/true`, `cmd.exe /c exit 0`, `tasklist.exe`). Pure window rules live in `wedgeWindow.ts`; probe interpretation in `wedgeEvidence.ts`. On a shared login only the host maintainer samples (new heartbeat + published state in `HostMaintenanceStore`, 10-minute takeover). A two-family candidate gets one judge call per wedge condition (`src/monitoring/MachineWedgeJudge.ts`, attribution `MachineWedgeJudge`, provenance decision point `machine-wedge-judge`), and the verdict row records the rungs that WOULD run. A candidate, or one family positive for 2 hours, sets `forcedDueAt`, which the paper drain (`DrainRehearsal`) now reads into its `due` flag. The rung-7 operator notice (`src/monitoring/MachineWedgeNotice.ts`) exists behind its own flag `machineMaintenance.wedgeRestart.dryRunNotice`, **default OFF in this increment**, and passes the self-action governor (`machine-wedge-notice`). `GET /machine-maintenance` and its pool view gain a `wedge` block. Wiring in `commands/server.ts` sits inside the existing dev-gated, throwaway-excluded machine-maintenance block.

## Decision-point inventory

- `Is this machine wedged and what to do` (spec: `judgment-candidate`) — add — floor: two-family, 3-observation, 20-minute window with the 6-minute gap and freshness rules (code, `wedgeWindow.ts`); arbiter `machineWedgeJudge` with a bounded space of four; deterministic fallback (gentle rungs + `forcedDueAt`) on no provider, error, unparseable answer or budget. In this build the arbiter's output is recorded only.
- `forcedDueAt` → paper drain `due` — add — a signal into the watch-only rehearsal.
- `Wedge maintainer` (host heartbeat) — add — who samples on a shared login.
- `Send the dry-run notice` — add — invariant gates: flag on, one per wedge condition, ≤1 ordinary + ≤1 breaker notice per 24 h, governor admission.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing in this change refuses, holds or stops anything; it only records. The closest analogue is a false candidate: a healthy-but-saturated machine. F4 reads `negative` when the processor is busy (idle < 30%), so a saturated machine does not feed F4; and a candidate needs a second, causally different family as well.

**Kept deliberately, and its cost:** F4's `cpu-busy-not-wedged` is a NEGATIVE observation, so it RESETS every pair that includes F4 (`F1+F4`, `F2+F4`), and the single-family F4 run. A machine that is wedged AND has a busy processor (for example a runaway process pinning the CPU while the GUI path is stuck) cannot form an F4 pair candidate; only `F1+F2` can still form. This is the spec's own F4 definition ("while CPU idle >= 30%"), chosen to keep healthy-but-saturated machines from forming candidates; the second-pass review asked that it stay as is and that the reset be stated here.

---

## 2. Under-block

No block/allow surface. As a detector it misses, by construction and stated in the status `limits`:
- **macOS F1 is unread** (`canary-not-shipped`): the spec's signed no-UI canary app is not shipped and the capture probe is not wired. A Mac can only form a candidate from F2 + F4. The 2026-11-01 Studio incident (GUI wedged, `-600` launch failures) would likely have shown F1 only, so this build would probably NOT have caught it. That is the single largest gap.
- F2's kernel-zone reading (`data.kalloc.1024`) is not wired (`kernelZoneRead: false` in the detail).
- F4's "session spawn failures for system reasons" has no counter yet; it reads `null` (unknown), never zero.
- F3 is not built.
- F4 negative on a busy processor resets F4 pairs (see section 1).
- The window is in memory: a server restart or maintainer takeover starts it over (the gap rule would anyway), so a wedge that restarts the agent server every 15 minutes never forms a candidate.

---

## 3. Level-of-abstraction fit

Detection is a low-level deterministic floor (window arithmetic over fixed probes), and the judgment sits at the authority level (one LLM call with structured context), matching the spec's Judgment Within Floors split. It uses existing primitives instead of re-implementing: the read-only command table (one `execFile`), the host store's lock, the machine load sampler (F4), the honest lock reading (F1 eligibility on macOS), the shared intelligence provider, the provenance seam, the self-action governor and the existing attention-item path. The judge and notice live outside the maintenance folder so the folder's source lint (no actor, import allowlist) still holds.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Every output is a record: audit rows, a status block, a `forcedDueAt` timestamp read by a paper drain that itself cannot act, and (only if the flag is turned on) one attention item. The judge's proposal has no consumer that acts on it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The wedge decision is a competing-signals point and is handled as the spec declares in `## Decision points touched`: floor (two-family window) + arbiter (`machineWedgeJudge`) + deterministic end rung. The static window rules are the floor, not the decision. The notice gates (one per condition, 24-hour cap) are invariants on a self-triggered emit, not a judgment.

---

## 5. Interactions

- **Shadowing:** none. The monitor runs on its own 60 s timer, independent of the drain rehearsal and browser care.
- **Double-fire:** the rehearsal and the wedge monitor both read `kern.boottime`/`os.uptime`; reads only. The notice uses the same attention path as other system items; its id is `machine-wedge:<episode>` so the store dedupes a repeat.
- **Races:** the maintainer claim and the published state go through `HostMaintenanceStore.withLock` (200 ms bounded wait, then "not the maintainer this tick"). A write from a stale generation is refused. Two agents on one login never both sample; verified by unit test.
- **Feedback loops:** `ps`, `systemd-run` and `cmd.exe` add a little load every 2–10 minutes; at most four short children per sample, hard timeouts 5–10 s (SIGKILL), single-flight. A child stuck in the kernel cannot be killed by any signal; the runner settles it anyway after timeout + 500 ms as `timedOut` (code `no-exit`), and while that child is still out there the same probe is not started again (code `previous-still-running`), so a wedged machine holds at most one stuck child per probe (four in all) instead of one per sample. F4 reads the agent's own event-loop lag; sampling does not run on the event loop (async children), so it cannot meaningfully feed its own F4 signal.
- **Rehearsal:** `forcedDueAt` makes the paper drain record `due: true` for the next window(s) until a boot. That changes rehearsal evidence rows (`due`) only.

---

## 6. External surfaces

- **Other agents on the same machine:** yes, deliberately: two new host files `~/.instar/host-maintenance/wedge-maintainer.json` and `wedge-state.json`, readable by every agent on the login. Only the maintainer writes them.
- **Install base:** dark on the fleet (machineMaintenance dev-agent gate). Throwaway agents excluded.
- **External systems:** one LLM call per wedge condition (≤6 per 24 h) through the shared provider. Telegram only if the notice flag is turned on.
- **Persistent state:** the two host files and `logs/machine-maintenance.jsonl` (2 MB rotation, metadata only: reason codes, numbers, ids).
- **Linux:** `systemd-run --user` starts one transient no-op unit per sample (collected). On a machine without a user manager it fails; F1 then stays `ineligible` because the probe never passed this boot.
- **Operator surface:** no operator-facing action is added. The notice, when enabled, says plainly that nothing was done and the restart button is not built; it offers no control that does nothing.

---

## 6b. Operator-surface quality

No operator surface — not applicable (no dashboard file touched).

---

## 7. Multi-machine posture

**machine-local BY DESIGN, proxied-on-read.** Wedge samples are readings of this machine's own hardware and session (spec: `machine-local-justification: hardware-bound-resource`). The pool-wide question is answered by the existing `GET /machine-maintenance?scope=pool`, whose self row now carries `wedge`. Notices are one-voice per host (only the maintainer can send) and per machine (episode ids carry the machine id). Durable state lives in the host store, so a co-resident takeover inherits it; it does not strand on topic transfer (not topic-bound). No URLs generated.

---

## 8. Rollback cost

Pure code change. Revert and ship a patch, or set `machineMaintenance.enabled: false` (read live: the monitor stops sampling at its next tick). Leftover host files are inert when nothing reads them; deleting `~/.instar/host-maintenance/wedge-*.json` is safe. No user-visible regression during rollback: the notice is off by default.

---

## Conclusion

The dry-run half of Part E is built and bounded: sampling, window rules, maintainer rule, judge with provenance, `forcedDueAt`, status, audit, and the rung-7 notice behind its own default-off flag. Nothing actuates. Main honest gaps: macOS F1 unread, F3 and the kernel-zone and spawn-failure readings not wired, enrolment absent (so "maintainer" is first-claim, not the enrolling agent), no operator dismissal of `forcedDueAt`, and the Jev-first cascade not wired (the judge uses the shared provider's routing). The second-pass review raised a blocking hang (a probe child stuck in the kernel stopped the sampler) and two durability gaps; all three are fixed below and await the reviewer's re-check.

---

## Second-pass review

**Reviewer:** coordinator's second-pass reviewer.
**Independent read of the artifact: concern raised.** Re-check of the fixes below is PENDING.

1. **BLOCKING — a probe child stuck in the kernel (U/D state) never exits**, so `execFile`'s timeout never fires its callback. `runCall` (readings.ts) never settled, `Promise.all` in `WedgeMonitor.sample()` never settled, `sampling` stayed true for good, and the heartbeat stopped: on exactly the machine the feature exists for, the sampler would go silent after one sample. **Fixed:**
   - `runCall` now races the child against its own timer and settles `{ timedOut: true, code: 'no-exit' }` at timeout + 500 ms whether or not the child ever exits; `killSignal: 'SIGKILL'`; a synchronous spawn throw (EAGAIN) settles as a failure.
   - A probe name whose child never exited is not started again (`previous-still-running`, still a timed-out result), so stuck children cannot pile up.
   - The monitor bounds every await of a sample independently of the runner: each probe (timeout + 2 s → timed-out), boot-time and lock readings (10 s → null/unknown), the judge (120 s → fallback `judge-timeout`) and the notice (60 s → `failed`). A sample always completes and `sampling` always resets.
   - Timed-out results are evidence: F2 reads `ps-timed-out` (positive), F1 `probe-timed-out` (positive once the probe has passed this boot), WSL `tasklist-timed-out`.
   - Tests: a fake spawner that never calls back — the sample completes within the bound, F2 is `ps-timed-out`, the next tick samples again, and no second child is started; the runner settles at exactly timeout + grace and asks for SIGKILL; a probe dependency that never settles is bounded by the monitor.
2. **Unknown boot time was treated as "not recent"**, so a `restart-now` proposal would record rungs 1–5 on a machine that may have just restarted. **Fixed:** `recentlyRestarted === null` now caps the outcome like a recent restart (`cappedAtNotice: true`, `cappedBecause: 'boot-time-unknown'`, `bootTime: 'unknown'`, no rungs recorded). Test added.
3. **The judge call was persisted only after it returned**, so a crash or maintainer takeover mid-call would call the judge again for the same condition. **Fixed:** the call is counted in `judgeCalls` and the condition is marked judged, then published to the host store, BEFORE the judge is awaited; the same is done before the notice is awaited (`notice: 'pending'`), so a crash mid-send never sends a second one. The cost, accepted: a crash mid-call leaves that condition with no recorded verdict. Test: the host file read from inside the judge call already holds the call and the judged condition, and a restarted monitor on the same store never calls the judge again.
4. **F4 `cpu-busy-not-wedged` resets a pair.** Kept as is at the reviewer's request; stated in sections 1 and 2.

Reviewer re-check of 1–3: **pending.**

---

## Evidence pointers

- `tests/unit/machine-wedge-window.test.ts`, `tests/unit/machine-wedge-monitor.test.ts`, `tests/unit/machine-wedge-judge.test.ts`
- `tests/integration/machine-wedge-route.test.ts`
- `tests/e2e/machine-wedge-lifecycle.test.ts`
- `tests/unit/self-action-convergence.test.ts` (controller `machine-wedge-notice`)

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action` — this change adds a self-triggered recurring controller: the `WedgeMonitor` sampler, which on its own evidence calls an LLM judge and (flag on) raises an operator notice.
- **closure:** `guard`
- **guardEvidence.citation:** `tests/unit/self-action-convergence.test.ts` (controller `machine-wedge-notice` in `src/testing/selfActionRegistry.ts`, `modelsPath: src/monitoring/MachineWedgeNotice.ts`), plus the governor policy `machine-wedge-notice` in `src/monitoring/selfaction/policies.ts`.
- **guardEvidence.enforcement:** `ratchet`
- **guardEvidence.howCaught:** under the pinned worst case (two families positive at every 2-minute sample forever, notice flag ON) the notice fires ONCE: the judge and the notice are keyed on a durable wedge *condition* in the host store, which closes only on a real negative observation of one of its families or a new boot. A server restart or maintainer takeover starts a fresh window and re-forms the candidate as a new episode, but it is the same condition, so no second judge call and no second notice (`boundK` 1, `perTargetBoundK` 1 over 24 h and at 2× the horizon; same bound when reconstructed at 25/50/75% and before every tick). For a flapping machine (outside the fixture) notices are further capped at one ordinary and one breaker notice per 24 h, and the governor class allows 1 per machine and 3 in all per 24 h.
- **component:** `WedgeMonitor` / `MachineWedgeNotice`

**The sampler itself and registration.** The recurring work that is not a notice is bounded in code and does not need its own registry entry: one sample at a time (single-flight), at most one every 2 minutes and one every 10 while nothing is positive; each sample runs at most four fixed read-only children with 5–10 s hard timeouts; the 60 s heartbeat is one lock + one small file write. The LLM judge is at most one call per wedge condition and at most `JUDGE_MAX_PER_DAY` (6) per rolling 24 h, persisted in the host store so a restart cannot reset it, and runs only on the host maintainer. Registration in `selfActionRegistry.ts` is done for the emit that reaches a person (`machine-wedge-notice`); the probes are reads, and the judge call is an LLM call bounded by the budget above and enrolled in the Decision Quality census (`machine-wedge-judge`, `budget:20`).


Reviewer re-check (2026-11-03 00:52 PST): Concur with the review. All three fixes hold. Residual note: the second-run guard is per process, so the worst case is about one stuck `ps` per agent on the login, which is bounded.
