# Side-Effects Review — Trustworthy machine load, P2 (overload admission + recovery slot)

**Version / slug:** `trustworthy-machine-load-p2`
**Date:** `2026-10-25`
**Author:** `echo`
**Second-pass reviewer:** `reviewer subagent (independent read, appended below)`
**Tier:** 2 (spec-driven; `docs/specs/trustworthy-machine-load-and-mesh-floor.md` Part C, converged over 3 cross-model rounds, approved by Justin 2026-10-25 14:19 PDT). Size: 11 source files (3 new: `workAdmission.ts`, `overloadSelfHelp.ts`, the route) + template/migrator/manifest/registry entries + 5 test files, ~750 LOC net. Effort: 0 further spec rounds (Part C was converged with the spec), 1 second-pass round (4 should-fix findings, all fixed below), 1 commit attempt — in proportion for a Tier-2 gating phase that ships dry-run.

## Summary of the change

Phase 2 of the spec. (C1) `src/core/workAdmission.ts` — `WorkAdmission` is fed every verdict of the phase-1 `MachineLoadSampler` (`onSample`) and holds an open/closed state: closed at `saturated`/`impaired`, reopened after 5 consecutive `ok`/`elevated` samples (`unknown` breaks the streak, never closes). `SessionManager.spawnSession` (automatic work) and `spawnInteractiveSession` (operator work) consult it through `setAdmissionGate()`; the scheduler's `canRunJob` is wrapped so a closed machine answers skip reason `overload` (bounded retry, then the next cron window). (C2) A `HostSpawnSemaphore` of capacity 1 in `~/.instar/host-recovery-slot.json` is the host-wide recovery slot: while closed, an operator session starts only by taking it; released on `sessionComplete`, reclaimed when the holder's session is seen gone. (C4) After 3 consecutive overloaded samples, one attention item per closed episode lists the top processes (async `ps`, `src/core/overloadSelfHelp.ts`). (C5) The load report carries `acceptingWork`/`admissionEnforced`; `PlacementExecutor` skips a machine whose FRESH, ENFORCED report says `acceptingWork:false`, queues with `all-machines-refusing-work` when every candidate refuses (server sends one fixed holding notice on the deterministic path per topic per 30 min + one deduped attention item), and — only when THIS machine enforces admission — ranks candidates by evidence tier before least-loaded. `GET /work-admission` is the status read. Dev-gated (`monitoring.workAdmission`) and dry-run first: in dry-run every refusal is logged/counted, nothing is refused, `admissionEnforced:false` is advertised so peers keep placing work here.

## Decision-point inventory

- `SessionManager.spawnSession()` — **modify (new refusal, enforced mode only)**: `AdmissionRefusedError` before the tmux spawn when closed. Dry-run: no change. A thrown gate error fails OPEN (logged).
- `SessionManager.spawnInteractiveSession()` — **modify (new refusal, enforced mode only)**: after the absolute-limit check, an operator session while closed must take the recovery slot; refused with `recovery-slot-in-use` when held. Dry-run: no change.
- `JobScheduler.canRunJob` (server composition) — **modify**: `overload` skip ahead of the memory/quota gates; an existing skip-and-retry path, not a new mechanism.
- `PlacementExecutor.decide()` — **modify**: a new candidate filter (refusing machines) and a new queued reason; the evidence ranking is seam-gated and OFF by default (byte-identical ordering unless this machine enforces).
- `MachineLoadSampler` — **modify (producer)**: two optional deps; absent ⇒ byte-identical report.
- `WorkAdmission` — **add**: the authority, deterministic, dry-run first.
- The all-refusing holding notice / attention item — **add**: a signal on the deterministic send path.

---

## 1. Over-block

- **Enforced mode only.** A machine whose own verdict is `saturated`/`impaired` for 2 of the last 3 samples refuses NEW automatic work. False positives come from the verdict table's thresholds (spec B2 calls them starting values, calibrated from phase-1 shadow logs) — which is exactly why this ships dry-run: `counters.wouldRefuse` and the audit show every refusal it would have made before any is real.
- A job skipped for `overload` gets the scheduler's bounded retries, then waits for its next cron window: a long overload episode can make a once-a-day job miss a day. Accepted (the alternative is running it on a machine that cannot).
- The recovery slot is ONE per host: a second operator session on an overloaded machine is refused until the first ends. Spec C2 asks for exactly this ("one session that can assess and act"). A refused inbound message takes durable custody in the inbound queue when that queue is live (the user gets the fixed "your message is saved" notice on the deterministic path and the drain delivers it when the machine reopens); where the queue is dark (it ships dark; single-machine agents have none), the cold-start fallback reply names the reason and asks for a resend — loss-with-notice, never silence. The enforce decision (`dryRun:false`) should be taken together with the inbound queue's own graduation.
- Inbound non-operator users' topic spawns use the `operator` lane (all `spawnInteractiveSession` callers do); under enforcement they compete for the same single slot. Acceptable for a dry-run phase; noted for the enforce decision.

## 2. Under-block

- Admission is per NEW session; existing sessions keep taking messages and keep spending. Moving work off a machine is P3 (spec Part D), not this phase.
- `spawnSession` callers that run outside `SessionManager` (none found — every LLM subprocess rides the spawn cap, every session rides these two methods) are not covered; a future direct `tmux new-session` would bypass admission exactly as it bypasses the session limit.
- Placement reads a PEER's refusal only from a fresh (≤60 s) ENFORCED report: a peer in dry-run, on older code, or with a stale report is never treated as refusing — it is ranked lower (C5), never excluded. Honest degradation, not a gate.
- The recovery slot cannot stop an outside process from eating the headroom (spec C1/C2 say so: best-effort headroom, not a hard reservation).

## 3. Level-of-abstraction fit

Right layers. Admission sits at the two session-creating methods every caller already funnels through (the same chokepoint as `maxSessions` and the absolute limit), the scheduler gate is the existing `canRunJob` composition point (memory and quota gates already stack there), the recovery slot IS the existing host semaphore primitive (no second counting mechanism), and the cross-machine effect rides the existing load report → `PlacementExecutor` path. The self-help notice reuses the attention queue; it does not grow a new sentinel. The C3 `nice +5` change is deliberately NOT here: it touches the shared spawn argv of three frameworks and belongs with P3's cut (tracked in the release note).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — this change adds blocking authority (an enforced refusal of a spawn / a job / a placement). It is admissible because: (a) the input is not a brittle single check — it is the phase-1 verdict over several independent signals with a 2-of-3 quorum, a boot/wake grace, and `unknown` never closing; (b) the authority only DEFERS (jobs retry, messages stay in durable custody, nothing is dropped or killed) and always leaves the operator a path (the recovery slot; the lifeline fallback names the reason); (c) it ships dry-run with its would-refuse record as the calibration evidence, and the spec's P4 puts a model assessment above the table for conflicting signals before any widening.
- Everything else here (the advert, the holding notice, the attention items, the audit) is a signal.

## 4b. Judgment-point check (Judgment Within Floors standard)

The close/reopen rule is a static heuristic over the verdict. The floor is "never refuse the operator everything" (the recovery slot + fallback reply), the arbiter for the day the thresholds are wrong is the dry-run would-refuse record (read before enforcing) and the spec's P4 model assessment; the operator levers are `dryRun:true` (soft, live) and `enabled:false` (kill switch, live on the next sample).

## 5. Interactions

- **Shadowing:** admission runs AFTER `maxSessions` / the absolute limit (those messages are unchanged); the scheduler's `overload` skip runs BEFORE the memory and quota gates (a closed machine is reported as `overload`, not mislabelled `memory-pressure`). The memory monitor's own `canSpawnSession` keeps working independently.
- **Double-fire:** the reaper's CPU-aware pressure (`HostPressureSampler`) and this admission read different inputs and act on different things (reaping existing vs admitting new); they can both fire on the same overload, by design. The self-help item and the all-refusing item are deduped by hour and by episode.
- **Race:** `releaseEndedSlots` prunes holders for sessions no longer listed on this agent; a holder of ANOTHER agent (different id prefix) is never touched; a holder from a dead pid is reclaimed by the semaphore's own prune (same host only, df-local gated).
- **Ordering:** the sampler calls `onSample` after caching the sample and reads the advert at `read()` time, so a report carries the admission state AFTER the verdict that produced it — no lag between the verdict and what peers see.
- **Hard pin:** a pin to a refusing machine queues through the existing `hard-pin-unavailable` path and gets that path's escalation, not the all-refusing holding notice (the notice keys on `all-machines-refusing-work`).
- **Recovery-slot reclaim:** a slot this process granted is never reclaimed as "ended" inside a 5-minute startup grace (an operator session is saved as `running` only after its spawn completes, which is slow under overload — the race the second pass found). A slot held by a spawn that failed after the grant leaks until the grace ends or the pid dies — bounded.
- **Lock failure ≠ holder:** `acquire()` answers false both at the cap and when the holders lock cannot be taken; a lock failure with no real holder ADMITS the operator session (fail open, counted as `slotLockFailures`, audited `slot-lock-failed`) — it is never reported as `recovery-slot-in-use`.
- **Scheduler polling:** the scheduler gate uses the non-counting `check()` (its own `schedulerChecksRefused` counter, no audit row), so `refused` counts sessions actually refused, not gate polls.

## 6. External surfaces

- Mesh: two optional fields on the load report (ignored by older peers; clamped on receive). No new RPC.
- User-facing: one fixed holding notice (deterministic send path) when every machine refuses, and one when this machine's own admission refuses a cold spawn that the queue took custody of; one attention item per closed episode for self-help (id = the episode's close time); one all-refusing attention item deduped per UTC hour (there is no cross-machine episode to key on).
- Host: `~/.instar/host-recovery-slot.json` (+ `.lock`), the same shape as the spawn-cap holders file.
- Config: `monitoring.workAdmission` (new, omitted by default). Timing-dependent: the 15 s sample cadence and the 5-sample reopen are the only clocks.

## 7. Multi-machine posture (Cross-Machine Coherence)

Admission state is **machine-local by design** (each machine protects its own resources — spec G2) and **proxied-on-read** to peers through the load report on every heartbeat / `session-status` (`acceptingWork`, `admissionEnforced`) and `GET /pool`. The recovery slot is **host-local** on purpose (one per physical machine, shared by co-resident agents). Durable state does not strand on topic transfer: a queued message stays in the existing durable inbound queue, which already survives moves. Notices are one-voice: the holding notice goes from the machine that routed the message (one per topic per 30 min); the attention items are deduped by id.

## 8. Rollback cost

Config: `monitoring.workAdmission.dryRun:true` is the soft lever (read live: the next decision is would-refuse only and the advert flips to `admissionEnforced:false`, so peers place here again); `monitoring.workAdmission.enabled:false` is the kill switch (also read live on every sample and admit: the machine reopens on the next sample, the advert is withdrawn, the route keeps answering with `enabled:false`). Code: revert the PR; the two report fields are optional and ignored by every reader when absent; the holders file is harmless when unread. No data migration; the audit log is append-only observability.

---

## Second-pass review

**Round 1 — reviewer subagent (independent read of the artifact + diff): "Concern raised"**, 4 should-fix + 7 notes. Resolutions (all in this change):

1. Recovery slot reclaimed while the operator session was still booting (`releaseEndedSlots` vs `running` saved after spawn) → **fixed**: in-process grant map + 5-minute startup grace (`SLOT_STARTUP_GRACE_MS`), pinned by test.
2. `enabled` evaluated once at boot while the artifact claimed a live kill switch → **fixed**: `waConfig()` resolves `resolveDevAgentGate(c?.enabled, config)` on every call; §4b/§8 reworded (dryRun = soft lever, enabled:false = kill switch, both live), pinned by test.
3. Un-acked `queued` falls to local dispatch → enforced refusal → "resend" without custody → **fixed where the queue is live**: an `admission-refused` cold-spawn failure now takes durable custody (`enqueueLive`, reason `work-admission-refusal`) and sends the fixed "your message is saved" notice; without a live queue the honest fallback reply stands (§1/§7 reworded; the enforce flip is tied to the queue's graduation).
4. Lock failure mislabelled as `recovery-slot-in-use` and refused → **fixed**: a false `acquire()` with no real holder admits (fail open), counted + audited, pinned by test.
5. Ordering note (advert is after the verdict, no lag) → **artifact corrected**. 6. Scheduler polling inflating `refused` → **fixed** (`check()`, separate counter, pinned by test). 7. Hard-pin notice gap → **documented** (§5). 9. Attention-id dedup → self-help now keyed per episode (close time, pinned by test); all-refusing stays per UTC hour and the artifact says so. 10. Orphaned `processFootprintMonitor` docblock → **fixed**. 8, 11 → confirmed, no change.

**Round 2 — reviewer re-verification: "Concur with the review (two bounded should-fixes remain, no blocker)".** Resolutions:

1. A spawn that fails AFTER taking the recovery slot kept it for the 5-minute grace → **fixed**: `SessionManager.setAdmissionGate(gate, release)` now carries a release hook, called on the tmux-create failure and on the resume-failed path (before the fresh respawn re-admits on its own); wired to `WorkAdmission.releaseSlotFor`.
2. Lock-failure fail-open has two narrow double-admit windows (another agent inside its critical section but not yet written; an unreadable holders file reads as zero) → **accepted and named here**: reachability over protection by design, both audited as `slot-lock-failed`, bounded by the semaphore's 2 s busy-wait deadline.
3. Scope confirmed; 4. Custody is BOUNDED by the inbound queue's hold budget and attempt cap: a row that outlives them ends in the queue's existing attempts-exhausted loss notice, never silence → the saved-message notice no longer promises an answer "as soon as", and says the user will be told if it takes too long. 5. Re-enable after a disable resumed a stale closed state → **fixed**: a sample while disabled clears the episode (pinned by test). 6. All-refusing attention item is keyed per UTC hour (stated in §6). 7. Dry-run safety re-confirmed.

Reviewer concurred after round 2; no further round needed.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action` — this change adds a self-triggered controller (`WorkAdmission`: closes/reopens admission on its own verdict feed and raises the self-help notice; the all-refusing and custody notices).
- **closure:** `guard`
- **guardEvidence.citation:** `tests/unit/self-action-convergence.test.ts` (controller `overload-admission-self-help` in `src/testing/selfActionRegistry.ts`, modelling `src/core/workAdmission.ts`)
- **guardEvidence.enforcement:** `ratchet`
- **guardEvidence.howCaught:** under the pinned always-`saturated` fixture the REAL `WorkAdmission` closes once (a state transition, not an emit), emits the self-help notice once per closed episode (`boundK` 1, `perTargetBoundK` 1, horizon-independent over 40 and 80 ticks of the real 15 s cadence) and never reopens because the 5-good-sample hysteresis never clears — the settling brake is the per-episode latch plus the reopen hysteresis. The other emits are rate-bounded by construction: the all-refusing holding notice once per topic per 30 min; the custody notice one per refused inbound message (user-driven, not a loop). Restart posture: the latch is process-local; a reconstruction under the same overload needs ≥2 fresh samples (30 s) + 3 overloaded samples (45 s) before it can fire again, so a restart loop is rate-floored at one item per ≥75 s and bounded by the supervisor's restart backoff.
- **component:** `WorkAdmission`
