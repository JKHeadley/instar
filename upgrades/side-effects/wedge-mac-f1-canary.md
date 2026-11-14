# Side-Effects Review — macOS wedge evidence: F1 canary app and F2 kernel zone

**Version / slug:** `wedge-mac-f1-canary`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `not yet run (left uncommitted for the coordinator's review)`

## Summary of the change

Closes two macOS gaps in Part E of `docs/specs/machine-self-maintenance.md` left by PR #2650. (1) F1 on macOS: a minimal no-UI app bundle (`src/native/wedge-canary/macos/InstarWedgeCanary.swift` + `Info.plist`, `LSBackgroundOnly` and `LSUIElement`, `exit(0)` at once) is built, signed and packaged by `scripts/build-native-desktop-host.mjs` into `dist/native/InstarWedgeCanary.app`, using the desktop helper's compile and signing path and identity. The wedge sampler opens it through LaunchServices with `open -g -j` (new fixed entry `guiCanary` in the read-only command table in `readings.ts`) via the existing bounded runner. Exit 0 is negative; a nonzero exit or a timeout is positive once the canary has passed this boot, and ineligible while `lockState` is `locked` or the console (`stat -f %Su /dev/console`, new entry `consoleOwner`) belongs to the login window or another person. (2) F2 on macOS: `zprint -L data.kalloc.1024` (new entry `kernelZone`) is read unprivileged; in-use element count x element size over 4 GiB is positive (`kernel-zone-over-limit`); unread is named, never zero. `wedgeEvidence.ts` holds the pure parsing and classification; `WedgeMonitor.ts` gains two optional deps (`canaryAvailable`, `ownUser`) and runs the three new probes inside the existing single-flight sample; `commands/server.ts` wires them. Release plumbing: `check-native-desktop-release.mjs`, `publish.yml`, `ci.yml` and `release-local.mjs` require and carry the bundle. The CLAUDE.md wedge section's evidence sentence is updated, with a content-sniffed migration for existing agents.

## Decision-point inventory

- `F1 evidence on macOS` (Part E evidence family) — modify — from always `unknown` to a classified canary reading under the spec's eligibility rule. Feeds the existing window rules and judge; decides nothing alone.
- `F2 evidence on macOS` — modify — one more positive input (`kernel-zone-over-limit`), per the spec's F2 row.
- `Is this machine wedged and what to do` — pass-through — unchanged window, judge, fallback and notice gates.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing here refuses, holds or stops anything; wedge restart is dry-run and has no rung in this build. The analogue is a false positive feeding a candidate:

- **Rapid relaunch race.** Measured live: an `open` started within milliseconds of a previous canary exit returned LaunchServices -1712 after 2.1 s (1 of 25 runs; 0 of 8 runs spaced 3 s). The sampler runs at most every 2 minutes on the host maintainer only, so this race needs another process opening the same bundle at the same instant. A single positive cannot form a candidate (3 observations over 20 minutes with the same two families positive at every one), and the next negative resets it.
- **Kernel zone is a ratchet.** `data.kalloc.1024` never shrinks before a reboot, so once over 4 GiB F2 stays positive for the rest of the boot. That is the spec's intent (the 2026-10-06 Studio panic was this zone at 20 GiB). Alone it forms no candidate; after 2 hours it brings the next scheduled window forward (`forcedDueAt`, on paper), which is the spec's single-family fallback.

---

## 2. Under-block

- **Capture half not built.** The spec's F1 row also lists helper `capture` of one frame and "2+ desktop grant failures in 30 min". Neither is wired: capture would need Screen Recording, an awake display and a non-`unknown` lock state, and the helper exposes no cheap one-shot read for the sampler. A Mac whose LaunchServices works but whose window server cannot draw reads F1 negative.
- **Running instance short-circuit.** `open` without `-n` activates an instance LaunchServices believes is running instead of starting one. The canary quits at once, so this needs a stuck canary from an earlier sample; if that happens, `open` either times out (positive) or returns 0 (a false negative). The spec names `open -g -j`; `-n` would pile up stuck instances on a wedged machine, so it was not added.
- **Unread console session does not block.** Only a definite non-own console owner makes F1 ineligible; an unread `stat` does not, because on a wedged machine reads fail first. A machine reached only over SSH with no GUI login fails the canary, but only as `ineligible` until it has passed once this boot.
- **zprint semantics on older macOS** are measured only on macOS 26.5. If an older version reports no in-use count unprivileged, the reading is `zone-row-unparseable` or a small number, never a false positive.

---

## 3. Level-of-abstraction fit

These are detectors at the evidence layer, which is where they belong: `wedgeEvidence.ts` turns probe results into family readings, and the existing window rules plus the `machineWedgeJudge` arbiter remain the only place a candidate or proposal is formed. The probes reuse the existing primitive (`READ_ONLY_CALLS` + the bounded `runCall` with SIGKILL, the no-exit guard and one outstanding child per probe name) instead of adding a spawn path. The console reading uses a file stat rather than the desktop helper so F1 eligibility does not depend on the helper that a wedged GUI would also hang.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The canary and zone readings are evidence-family inputs. They feed the window rules and, for a candidate, the `machineWedgeJudge` call; in this build the judge's output is itself recorded only. No reading blocks, restarts or notifies by itself.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The 4 GiB line and the eligibility rule (passed once this boot, not locked, console owned by this user) are the spec's own enumerated floor for the evidence family; the competing-signals decision (is the machine wedged, what to do) stays with the existing floor + judge declared in the driving spec.

---

## 5. Interactions

- **Shadowing:** the three new probes run inside the existing `Promise.all` of one sample, each with its own hard timeout (canary 10 s, console/zone 5 s, unchanged constants) and the monitor's outer bound. A stuck canary cannot delay the `ps` reading beyond the existing per-sample bound.
- **Double-fire:** only the host maintainer samples, so one canary launch per sample per login. The lock reader (`MachineLockStateReader`) and the desktop helper are untouched; the canary never runs the helper.
- **Races:** the measured -1712 race (section 1). The canary is opened by path, so a second copy (another checkout, a test) never answers for this one.
- **Feedback loops:** none. The canary writes nothing and the zone read is a read.
- **Tests:** a vitest run cannot launch the real canary unless it sets `INSTAR_REAL_WEDGE_CANARY_TESTS=1`; only the e2e lifecycle test does, so routine test runs do not add LaunchServices registrations for every checkout path.

---

## 6. External surfaces

- **Other agents on the same machine:** one canary launch per sample on the login (host maintainer only).
- **Install base:** every macOS install gains a ~110 KB app bundle under `dist/native/`. LaunchServices registers the bundle path the first time it is opened (a normal side effect of launching any app; no privacy entry, no Dock icon, no window).
- **External systems:** none at runtime. At release, the publish job uploads the bundle with the helper artifact and the Linux job restores its exec bit (`chmod 0755`) before the package check.
- **Persistent state:** none new. Readings land in the existing wedge snapshot and audit rows (numbers and fixed reasons; stderr is parsed for the error number only, never stored).
- **Timing:** `zprint` took ~0.2 s and `open` 18–75 ms live.
- **Operator surface:** no operator-facing actions. The readings appear in the existing `GET /machine-maintenance` `wedge` block.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** whether this Mac can start a program and how large its kernel zone is are facts about this machine only. The pool-wide question is answered by the existing proxied-on-read view (`GET /machine-maintenance?scope=pool`, the wedge block per machine). No notices, durable state or URLs are added.

---

## 8. Rollback cost

Pure code and packaging change. Revert and ship a patch; F1 on macOS returns to `unknown` and F2 loses the zone reading. The bundle left in an old `dist/native` is inert. Existing agents' CLAUDE.md keeps the updated sentence until the next migration; it remains accurate in spirit (it describes the reading, not a capability to act). No data migration, no agent repair, no user-visible regression.

---

## Conclusion

The macOS F1 row now has its canary half and the F2 row its kernel-zone half, both as signals under the spec's eligibility rules, both through the existing bounded runner, with nothing able to act. Open items: the F1 capture half and the desktop-grant-failure count (not built); notarization (no Developer ID certificate or notary credentials in the pipeline; the canary is signed with the release identity when one is configured, ad-hoc otherwise); a second-pass review.

---

## Second-pass review (if required)

**Reviewer:** not yet run
**Independent read of the artifact:** pending

---

## Evidence pointers

- Live canary runs on the Mac Studio, macOS 26.5.2: 25 runs, 24 exit 0 in 18–75 ms; one -1712 in a zero-gap burst; 8 of 8 at 3 s spacing.
- Live `zprint -L data.kalloc.1024`, unprivileged vs root: 332,120 in-use x 1024 B vs `cur size` 333,072 K.
- Tests: `tests/unit/machine-wedge-mac-canary.test.ts`, `tests/unit/machine-wedge-monitor.test.ts`, `tests/integration/machine-wedge-route.test.ts`, `tests/e2e/machine-wedge-lifecycle.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action` — this change modifies a self-triggered recurring controller (the `WedgeMonitor` sampler) so that each sample also launches a process (the canary app) on its own. It fixes no agent-authored-artifact defect.
- **closure:** `guard`
- **guardEvidence.citation:** `tests/unit/self-action-convergence.test.ts` (controller `machine-wedge-notice` in `src/testing/selfActionRegistry.ts`), plus the code bounds in `src/monitoring/machineMaintenance/readings.ts` (`runCall`: hard timeout, SIGKILL, no-exit guard, one outstanding child per probe name) and `WedgeMonitor.tick` (single-flight).
- **guardEvidence.enforcement:** `ratchet`
- **guardEvidence.howCaught:** control-loop edge: sample → `open` of the canary → reading → next sample delay. Steady-state bound: at most one canary launch per sample, samples at most every 2 minutes (every 10 while nothing is positive), host maintainer only, so at most 30 launches an hour per login and 6 an hour on a healthy machine. Settling brake: a canary `open` that never exits blocks every later canary launch on that process (`previous-still-running`), so a wedged machine accumulates at most one stuck `open` per agent process, never a pile. The launch has no effect beyond starting and ending a process that draws nothing; the person-reaching emit (the notice) is unchanged and remains under its registered ratchet.
- **component:** `WedgeMonitor` / `readings.guiCanary`

## Second-pass review (independent, 2026-11-03 04:29 PST)

Concur with the review. Nothing acts. The new reads are fixed, shell-free and bounded by the same runner. F1 eligibility is tested on both sides. The guard-test widening is minimal. The release pipeline keeps Linux and Windows paths unchanged and blocks a release only if the macOS build fails, the same as the desktop host today. The canary is `exit(0)` with no entitlements. Minor: every macOS dev build now compiles the canary; the F2 read depends on unprivileged `zprint` (measured on macOS 26.5), and an unparseable row reads "unread".
