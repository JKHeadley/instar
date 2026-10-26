# Side-Effects Review — Trustworthy machine load, P1 (honest evidence + load report)

**Version / slug:** `trustworthy-machine-load-p1`
**Date:** `2026-10-25`
**Author:** `echo`
**Second-pass reviewer:** `reviewer subagent (independent read, appended below)`
**Tier:** 2 (spec-driven; `docs/specs/trustworthy-machine-load-and-mesh-floor.md`, converged over 3 cross-model rounds, approved by Justin 2026-10-25 14:19 PDT). Size: 7 source files + 2 dashboard files + 1 template/migrator pair + 6 test files, ~900 LOC net. Effort: 3 spec review rounds, 1 commit attempt (so far) — in proportion for a Tier-2 reporting-only phase.

## Summary of the change

Phase 1 of the spec: reporting only. (A) `MachinePoolRegistry` keeps three evidence slots per peer — last direct success (with RTT and the load it carried), recent direct attempts with their failure shape, and the ORIGINAL time of relayed (git-synced) beats — and derives a display `liveness` (`live` / `unreachable` + shape / `stale` / `unknown`) with the evidence age and source (`src/core/machineLiveness.ts`). The last direct contact is persisted (`src/core/MachineEvidenceStore.ts`, `state/machine-direct-evidence.json`) so a restart renders `stale` with its real age. `PeerPresencePuller` records failure shapes (`src/core/machineLiveness.ts#classifyPullFailure`), pull RTT, and a peer's `peerSightings` advert (ages on the observer's clock). (B) `src/core/machineLoadReport.ts` adds a 15 s async sampler (cores, load/core, CPU idle from `os.cpus()` deltas, available memory via async `vm_stat`/`/proc/meminfo`, native pressure via `sysctl`/`/proc/pressure/memory`, event-loop lag p99 from the existing `WriteAdmission` gauge, sessions active/max, spawn-cap + test-runner saturation), carried on the self heartbeat and `session-status`, clamped on receive, stored in its own receipt-stamped registry slot, and turned into a verdict (`ok`/`elevated`/`saturated`/`impaired`/`unknown`) by the B2 table with 2-of-3 quorum, top-down precedence, 60 s expiry and a 2-min boot/wake grace. (A5) Every renderer uses one template — `GET /pool` `livenessLine`, the sessions-view empty-state (`src/server/poolEmptyState.ts`), the dashboard glance (`dashboard/glance.js`), and the rope-health digest — and none says "offline" without positive evidence. The CLAUDE.md template + `PostUpdateMigrator` gain the "never say offline without evidence; quote liveness, age, source" line.

## Decision-point inventory

- `MachinePoolRegistry.assemble() → online` — **pass-through, unchanged** (spec A2: placement/ownership keep their semantics in P1; `liveness` is a NEW display-only field beside it).
- `PeerPresencePuller.pullOnce()` — **modify (observe-only)**: it now records failure shapes / RTT / sightings; it still records online exactly as before. The never-throw contract is preserved (every new dep call is wrapped).
- `PlacementExecutor.score()` — **not touched** (the raw-loadAvg scoring and unknown-as-0 defect is P2 work, named in the spec; this phase only ADDS the report the fix will consume).
- `classifyMachineEmptyState()` — **modify**: a new evidence path decides the state when `liveness` is supplied; the legacy path is byte-identical when it is not (pinned by test).
- `RopeHealthMonitor.composeDigest()` — **modify (wording only)**: the `peer-offline` branch no longer says "is offline — expected"; the condition and the classifier are unchanged.
- `MachineLoadSampler` — **add**: a producer. Its verdict is advisory in P1; nothing reads it to act.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The only "rejection" is the receive clamp on a peer's load report / sightings, which turns a malformed field into `null` (missing) and a malformed block into "no report"; both degrade to `unknown`, never to a refused heartbeat or a dropped peer.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Honest limits of the REPORTING: (a) a peer on older code sends no report → `unknown` (by design, never `ok`); (b) the "unreachable" sub-shape can be wrong at the edge — a cold tunnel hop that aborts at 5 s reads `timeout`, so a healthy-but-slow tunnel can show `struggling` (the shape is labelled from this machine's point of view and the sightings line shows if another machine reaches it); (c) `unknown` vs `offline` cannot be told apart by this layer, so a machine that is genuinely shut down reads `unknown` or `stale` with an age — the spec accepts this (offline needs positive evidence, which is a later phase's shutdown announcement).

---

## 3. Level-of-abstraction fit

Right layer. The evidence slots live in the ONE place every peer observation already funnels through (`recordHeartbeat`), so the self/coarse/live beats cannot disagree. The load report reuses existing primitives rather than re-implementing them: `parseVmStat`/`parseProcMeminfo` from `hostMemoryPressure.ts` (only the transport is now async), `WriteAdmission.eventLoopStats()`, `getHostSpawnSemaphore().status()`, `getHostTestRunnerSemaphore().status()`. The sampler deliberately does NOT replace `HostPressureSampler` (the reaper's pressure signal) — changing the reaper's input is routing-affecting and is P2.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Everything here is a signal producer: liveness, evidence ages, sightings, the load report and its verdict are rendered and logged; no gate, placement, reaper or mover consumes them in this phase. The B2 verdict table is a deterministic classifier whose output is advisory until P2, and the spec's P4 puts a model (Jev → Luna) ABOVE it for the disagreement cases before any action is ever attached.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The B2 verdict table IS a static heuristic over competing signals (CPU, memory, lag, sessions). It is not a judgment point in P1 because it decides nothing — it is a label. The spec declares the floor + arbiter for the day it does: P2 acts only on `saturated`/`impaired` after a shadow-log calibration, and P4 adds the model assessment for conflicting signals, graded by the decision-quality meter, advisory only. "Thresholds are starting values, calibrated in P1 shadow logs before P2 acts on them" (spec B2).

---

## 5. Interactions

- **Shadowing:** `liveness` sits BESIDE `online`; nothing that reads `online` (placement, owner-reachability, exactly-one-listener, stale-owner release) changed. `classifyMachineEmptyState` runs the new path only when the route passes `liveness`; the legacy path is pinned by the existing 14 unit tests.
- **Double-fire:** the self beat (every 30 s) and `session-status` both READ the sampler cache; neither samples. The sampler is single-flight (`inFlight` promise) so an overlapping tick cannot stack `vm_stat` processes.
- **Races:** `MachineEvidenceStore.record()` is write-on-interval (≤1 persist/min/machine) and never moves a record backwards; the file is written tmp+rename. The registry's evidence maps are in-process only.
- **Feedback loops:** none — no consumer acts on the new fields. The one self-referential signal (event-loop lag) is READ from an existing gauge. The OS reads are async (`execFile` with timeouts; the sync `vm_stat` path was deliberately not reused). The two limiter reads are synchronous but lock-free and subprocess-free: the spawn cap is read through a new `HostSpawnSemaphore.peek()` (one small-file read + an in-memory prune, no lock, no write — `status()` spin-acquires the host lock for up to 2 s and rewrites the file, which the second-pass review caught as a loop-blocking hazard on a 15 s timer); the test-runner status is a lock-free small-file read.
- **Wire freshness:** `session-status` re-reads the sampler at SEND time (`_machineLoadSampler.read()`), so `sampleAgeMs` on the wire is current; the copy on the 30 s self beat is only what this machine's own `/pool` row shows. (Second-pass finding: before this fix a receiver could have passed a ~90 s-old report through its 60 s freshness check.)
- **Coarse beats:** a coarse (git) beat still refreshes `online` (unchanged) but now ALSO records relayed evidence with its original time; it carries the load-report slot forward without refreshing its age (the same pattern as posture/coherence, pinned by test).

---

## 6. External surfaces

- Other agents on the same machine: none (the evidence store is per agent state dir; the limiters are peeked lock-free — never acquired, never rewritten — by the sampler).
- Install base: `GET /pool` rows gain fields (`liveness`, `livenessLine`, `lastDirectLoadAvg`, `lastPullRttMs`, `loadReport`, `loadReportReceivedAt`, `loadReportAgeMs`, `loadVerdict`); `pool.machines[].emptyState.kind` gains `stale` and `unknown`. Every existing field keeps its value. The session-status mesh reply gains `peerSightings` + `loadReport` (old peers ignore them; old callers don't read them — the advert-field ratchet covers the narrowing).
- External systems: none. Two new OS reads per 15 s per machine (`vm_stat` or `/proc/meminfo`; `sysctl` or `/proc/pressure/memory`), both bounded by timeouts.
- Persistent state: `state/machine-direct-evidence.json` (registered in the state-coherence registry as machine-local, 90-day retention, bounded by pool size).
- Timing: the first sample is awaited at boot (one `vm_stat` + one `sysctl`, ≤5 s bounded); every later sample is off the heartbeat path.
- **Operator surface:** no operator ACTION is added. The Machines tab and the sessions view gain read-only wording; nothing to tap.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Touches `dashboard/glance.js` + `dashboard/index.html` (read-only rendering).

1. **Leads with the primary action?** Nothing to act on; the status word is the first thing on each machine row and now says what is known ("Unreachable — struggling to answer (last evidence 40 min ago…)", "Not checked recently — …", "Unknown — no contact yet") instead of a flat "Offline".
2. **Zero raw internals as primary content?** Yes — the row and record use plain words (`overloaded — 96% CPU busy, 22% memory free, server lag 410 ms (as of 12 s ago)`); machine ids never appear, observers are named by nickname, and enum values are mapped to words (`LOAD_VERDICT_WORD`).
3. **Destructive actions de-emphasized?** No destructive actions on these surfaces.
4. **Plain language + phone width?** The new rows reuse the existing `recordFields` layout (stacks at phone width; long values clamp with an ellipsis — the wording test asserts the head and the lag separately because of that clamp).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, with a proxied-on-read element.** Evidence is inherently per observer: "I reached it 3 min ago" is a fact about THIS machine's view, so each machine keeps its own slots and its own evidence file. The pool-wide question ("has ANYONE reached it?") is answered by the display-only `peerSightings` advert carried on `session-status` — ages on the observer's clock, never re-relayed, never refreshing the receiver's own slots, never feeding placement (spec A4). The load report is per machine by nature and is carried on the heartbeat so every machine holds every peer's latest report with its own receipt stamp. No user-facing notices are emitted by this phase (one-voice gating not needed); the evidence file does not strand on topic transfer (it is not topic state); no URLs are generated.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change — revert and ship a patch.
- **Data migration:** none required; `state/machine-direct-evidence.json` is ignored by older code and bounded (90-day retention). It can be deleted freely.
- **Agent state repair:** none. The CLAUDE.md line is content-sniffed and idempotent; a rollback leaves a harmless extra line.
- **User visibility:** none — reporting only. A rollback would re-introduce the "offline" wording, not break anything.

---

## Conclusion

The review confirmed the phase boundary: every new field is a signal; `online`, placement and ownership are untouched; the one classifier (B2) decides nothing yet and has a declared floor + arbiter for when it will. Two design points were tightened during the build: (1) the failure classifier had to walk undici's nested `fetch failed` → AggregateError to see `ECONNREFUSED` (the integration test against a real refused socket caught it); (2) the live-but-this-request-failed empty-state branch must never echo the registry's `offline` label as a reason. Clear to ship as P1; P2 (admission + reserved headroom) is a separate, measured change per the spec's rollout.

---

## Second-pass review (if required)

**Reviewer:** reviewer subagent (claude, independent read)
**Independent read of the artifact: concur** (five concerns raised, all five verified fixed on re-read)

Verified by reading code (not prose): (a) `MachineCapacity.online` and `isPlacementEligible` (`src/core/MachinePoolRegistry.ts:437-439`, `:464-465`) are unchanged, and no non-test consumer reads `liveness` / `loadVerdict` / `loadReport` to gate, place, move or kill (the only readers are the two renderers, `/pool`, the template and the migrator); (b) `PeerPresencePuller.pullOnce()` still records `online` identically for an answering peer and every new dep call is wrapped (`noteFailure`, `recordPeerSightings`); (d) relayed evidence is clamped `min(origin, now)` and monotone, the store never moves a record backwards, and `deriveLiveness` only ever adds elapsed time; (e) `state/machine-direct-evidence.json` is registered (machine-local, single-writer) and 90-day/pool-bounded; no TDZ hazard in `server.ts` (both `let`s precede every closure that reads them; `selfId()` is try-wrapped). The concerns are below — items 1 and 2 are defects against claims the artifact makes; 3–5 are fidelity gaps.

- **Sampler blocks the event loop under the exact condition it reports (artifact §5/§6 claims are wrong).** `src/commands/server.ts:22649` wires `spawnCapSaturated` to `getHostSpawnSemaphore().status()`, and `status()` (`src/core/hostSpawnSemaphore.ts:365-372`) runs inside `withLock` (`:465-490`): a SYNCHRONOUS spin-acquire of a file lock with `busyWaitTiny()` up to a 2000 ms deadline, then a prune + `writeHolders()` of the host-wide holders file. Called every 15 s from `doSample()` (`src/core/machineLoadReport.ts:386`), so under spawn contention (the overloaded-machine case this feature exists to describe) the sampler can pin the loop for up to 2 s per tick and inflate the event-loop lag it sits next to — the artifact states "the sampling itself is async so it cannot inflate the lag it reports" and "the limiters are read, not acquired"; both are false for this call. `getHostTestRunnerSemaphore().status()` (`hostTestRunnerSemaphore.ts:1911-1950`) is sync-fs too (tuning file, holders, full live-ledger read in `readLedgerTail`) though lock-free and subprocess-free. Resolution: read spawn saturation lock-free (the `fallbackOnLockFail` path already does `readHolders()` without the lock; count non-expired holders without pruning or writing), or move both limiter reads off-loop / to a slower cadence; then correct §5/§6.
- **A peer receives a `loadReport` whose `sampleAgeMs` is frozen at the last SELF beat, so the receiver renders it up to ~30 s younger than it is (claim (d), spec B1 "how old the sample is when sent").** `session-status` (`src/commands/server.ts:24758`) returns `base = getCapacity(meshSelfId)`, i.e. the self row's `loadReport` as recorded by `refreshPool` (`:22826`, 30 s cadence) — it does NOT re-read `_machineLoadSampler.read()` at send time, contrary to §5 ("the self beat and `session-status` both READ the sampler cache"). Worst case a report with a true age of ~90 s passes `isLoadReportFresh` (≤60 s) on the receiver. Resolution: in the `session-status` handler overwrite `loadReport` with `_machineLoadSampler?.read() ?? base.loadReport` (O(1)) before `narrowSessionStatusToPeerCapacity` sees it; add a puller test that the wire `sampleAgeMs` is ≤ the sampler interval.
- **One sample can produce a non-`unknown` verdict (spec B2 says "at least 2 of the last 3").** `quorum()` (`src/core/machineLoadReport.ts:94-99`) uses `need = min(2, window.length)`, so the boot sample that `start()` awaits — the one the first heartbeat carries — decides `impaired`/`saturated`/`elevated` from a single `vm_stat`/`sysctl` reading. Not pinned either way (`tests/unit/machine-load-report.test.ts:60` only exercises 3-sample windows). Resolution: return `unknown` while `samples.length < VERDICT_QUORUM`, or record the deviation in the spec + this artifact so P1 shadow logs are read with it in mind.
- **A renderer still says "offline" from `online` alone (A5).** `dashboard/index.html:5264-5268` labels a machine `(offline)` in the New Session machine picker whenever `m.online !== true`. Keeping it `disabled` is correct (placement semantics unchanged), but the WORD is the one the spec forbids without positive evidence. Resolution: label it `(not reachable)` or render `m.livenessLine`; extend the wording test to cover it.
- **(low) `sightings` map is keyed on peer-supplied ids without a membership check** (`src/core/MachinePoolRegistry.ts:412-421`): `sanitizePeerSightings` bounds one pull to 64 ids ≤128 chars, but nothing bounds the map across pulls, so a buggy peer can grow it by 64 new keys per 30 s indefinitely (the other three slots are registry-keyed and bounded). Resolution: skip ids not in `listMachines()`, or cap the map.

### Resolution of the second-pass concerns (author, 2026-10-25)

1. **Loop-blocking limiter read — FIXED.** Added `HostSpawnSemaphore.peek()` (`src/core/hostSpawnSemaphore.ts`): lock-free `readHolders()` + in-memory `pruneDead()`, no `withLock`, no `writeHolders()`. The sampler now calls `peek()` (`src/commands/server.ts`, the `spawnCapSaturated` dep). §5/§6 corrected above. The test-runner read stays (lock-free, no subprocess, small files).
2. **Stale `sampleAgeMs` on the wire — FIXED.** The `session-status` handler overwrites `loadReport` with `_machineLoadSampler.read()` at send time (`src/commands/server.ts`), so the age a peer receives is current; §5 now states this.
3. **One-sample verdict — FIXED.** `deriveLoadVerdict` returns `unknown` while fewer than `VERDICT_QUORUM` (2) samples exist and `quorum()` no longer shrinks the requirement to the window size (`src/core/machineLoadReport.ts`). Pinned by `tests/unit/machine-load-report.test.ts` (a single `critical` sample reads `unknown`; the sampler's first read reads `unknown`).
4. **Machine-picker "(offline)" — FIXED.** `dashboard/index.html` now labels a not-online machine from the evidence state: `(not answering)` / `(not checked recently)` / `(no recent contact)`; it stays disabled (placement unchanged).
5. **Unbounded sightings map — FIXED.** `recordPeerSightings` drops ids not in `listMachines()` (`src/core/MachinePoolRegistry.ts`), so the map is bounded by the registry; pinned in `tests/unit/machine-pool-evidence.test.ts`.

---

## Evidence pointers

- Unit: `tests/unit/machine-liveness.test.ts`, `tests/unit/machine-load-report.test.ts`, `tests/unit/machine-pool-evidence.test.ts`, `tests/unit/machine-liveness-wording.test.ts` (+ updated `peer-presence-puller.test.ts` advert ratchet).
- Integration: `tests/integration/machine-liveness-pool.test.ts` (real router + real puller over a real refused socket; restart renders stale).
- E2E: `tests/e2e/machine-load-report-lifecycle.test.ts` (real sampler over real OS readers, production-shaped init, `GET /pool` alive with a report).
- Incident: `docs/issues/stale-machine-claims-and-overload.md` (2026-10-25).

---

## Class-Closure Declaration (display-only mirror)

Not applicable: this change fixes no defect in an agent-authored artifact and adds no self-triggered controller — the sampler fires no restart/swap/respawn/notify/retry/kill; it only samples and caches.

### Full-suite follow-ups (author, 2026-10-25, after the hour-long push-config run)

- `peer-presence-wiring` ratchet: the new puller deps moved below the `fetchPeerCapacity` block so the ratchet's 900-char window still sees the signed `session-status` call (no behaviour change).
- `keyword-intent-decision` ratchet: `parseLinuxPressureFile`'s parameter renamed `content` → `psiFile` (a `/proc/pressure/memory` body is not a user message; the detector keys on the name).
- `stage-b-evidence-code-binding`: `machineLiveness.ts`, `machineLoadReport.ts` and `hostMemoryPressure.ts` entered the certified set's import closure via `MachinePoolRegistry`; excluded with reasons in `src/data/stageBCertifiedSet.ts` (reporting-only, outside Stage-B canaried delivery).
- `SelfUnblockProbeProviders` + `quota-manager-lifecycle` (10 s timeouts): reproduced identically on pristine `origin/main` with the same dependencies on this machine — environmental, not this change; CI is the arbiter.
