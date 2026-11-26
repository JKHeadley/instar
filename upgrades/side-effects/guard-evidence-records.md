# Side-Effects Review — durable per-run records for the lease hand-back and identity divergence guards

**Version / slug:** `guard-evidence-records`
**Date:** `2026-10-28`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

CMT-1119: the 2026-10-28 feature maturation review found two load-bearing, dry-run guards with zero durable records — `multiMachine.leaseSelfHeal.preferredCaptainHandback` (counters only in memory, always empty on the preferred captain, which is where the review ran) and `multiMachine.identityReannounce.identityDivergenceMonitor` (latest-state file only, graded `not-instrumented` on `/guards`). This change adds a bounded JSONL writer (`src/core/guardEvidenceLog.ts`, 5 MB then one `.1` rotation), an optional `record` sink and a `guardStatus()` getter on `LeaseHandbackReconciler` and `IdentityDivergenceMonitor`, and the server wiring that appends to `logs/lease-handback.jsonl` / `logs/identity-divergence-monitor.jsonl` and registers both getters with `GuardRegistry`. The hand-back reconciler records on state change, on significant events, and at most hourly otherwise (it ticks every ~5 s). The divergence monitor records every completed 2-minute check, including each new divergence's `raise` disposition (`dry-run` / `raised`). One ordering fix: the reconciler now sets `lastEpisode` before emitting the metric for would-hand-back/offer/claim/failure/step-down, so the record carries the episode it describes (no decision depends on that ordering). Synthetic tests stage the two conditions the soak never sees on its own machine. Tier 1: 4 source files, ~185 LOC source, observability only, a revert fully undoes it. Effort: one spec-free Tier-1 pass, no review rounds beyond the second-pass reviewer.

## Decision-point inventory

- `LeaseHandbackReconciler.observe()` hand-back decision — pass-through — unchanged; a wrapper records state transitions around it.
- `IdentityDivergenceMonitor.tick()` raise-once-per-episode decision — pass-through — unchanged; it now also records the run.
- `GET /guards` grading of the two rows — modify — runtime getters registered, so the rows grade from a real `lastTickAt` instead of `not-instrumented`.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Evidence gap that remains: the hand-back reconciler only observes when the lease pull tick fires (multi-machine installs); on a single-machine agent it writes nothing, which is honest (it has nothing to do there).

---

## 3. Level-of-abstraction fit

Records are emitted by the component that makes the decision, through an injected sink, the same shape as `StaleOwnerReleaseEngine`'s decision trace. The runtime getters use the existing `GuardRegistry` seam that `/guards` already reads. No new parallel status surface.

---

## 4. Signal vs authority compliance

Pure signal. The records and getters hold no authority; every write path swallows failures (`@silent-fallback-ok`), and a test proves a throwing sink leaves the lease decision unchanged.

## 4b. Judgment-point check

No new heuristic at a decision point — not applicable.

---

## 5. Interactions

- `/guards` grading: the divergence row has `expectedTickMs: 120000`, so a registered getter makes it `on-dry-run`/`on-confirmed` from evidence and `on-stale` if the 2-minute timer stops — the intended grading. The getter is registered only inside the same `resolveDevAgentGate && identityStore` branch that constructs the monitor; `expectRuntime` stays false, so an enabled flag without an identity store still reads `not-instrumented` rather than an error.
- The hand-back getter is registered unconditionally and returns `{enabled:false}` when the reconciler was not built; its manifest row has no `expectedTickMs`, so a quiet single-machine install is never graded stale.
- Feature metrics (`lease-handback`) are unchanged and still fire per event, including per-tick `deferral`, which the durable log deliberately excludes.
- Raise path: `raise` now returns a disposition string; the real attention raise is unchanged.

---

## 6. External surfaces

Two new log files under the agent's `logs/` directory and two `/guards` rows that now carry runtime data. The records hold machine ids, fingerprint-free divergence ids (`identity-divergence:<kind>:<machineId>:<epoch>`), states and counters — no key material, no fingerprints, no message content. File mode 0600.

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: each machine records its own observations (the hand-back state is per-holder; the divergence check is per-observer). The point of the records is a per-machine soak trail; the existing `/guards?scope=pool` merged read already carries each machine's runtime projection. No notices are added, so no one-voice gating is needed.

---

## 8. Rollback cost

Revert the PR. The log files are inert leftovers (bounded at ~10 MB each) and can be deleted by hand; no state migration.

---

## Conclusion

Observability-only change that gives the maturation review the evidence it found missing, with bounded writes and no change to either guard's decisions. Safe to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (fresh context, read the diff not this conclusion)
**Independent read of the artifact: concur**

Concur with the review. Verified: no hand-back or divergence decision changes, including the five lastEpisode-before-metric reorderings (nothing in `metric()` or after it reads `lastEpisode` to decide); the monitor still persists state before recording, every record write is try/catch-wrapped and per-tick `deferral` is excluded, files rotate at 5 MB; both registry keys match `guardManifest.ts`, `lastTickAt: 0` before the first check grades stale (never on) and the boot tick clears it, the hand-back row has no cadence so a quiet machine is never stale; records carry no key material and are mode 0600; tests green. Non-blocking note: with `dryRun:false` but identity mutation coherence not allowed, the disposition reads `dry-run` — accurate, since nothing was raised.

---

## Evidence pointers

`tests/unit/guard-evidence-records-cmt1119.test.ts` (10 tests), plus the existing `LeaseHandbackReconciler.test.ts` (27), `IdentityDivergenceMonitor.test.ts`, `LeaseCoordinator-handbackConsent.test.ts` — all green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no new self-triggered controller (the change adds records only; it fires no restart, swap, spawn, notify, retry or kill) — not applicable.
