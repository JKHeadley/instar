# Side-Effects Review — Supervisor sustained-CPU-starvation restart guard

**Version / slug:** `supervisor-sustained-starvation-fix`
**Date:** `2026-06-17`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `(see Phase 5 section below — required: restart/recovery path)`

## Summary of the change

`ServerSupervisor.deferRestartForCpuStarvation()` decided whether to hold off restarting an alive-but-unresponsive server based on the **instantaneous** CPU load ratio (`loadRatioProvider() > maxLoadRatio`). On an oversubscribed box the 1-minute load average oscillates around the threshold, so a single sample dipping below it authorized a restart of a server that had been CPU-starved the whole time — and the restart's heavy boot deepened the starvation, producing a ~11–15-minute restart loop (2026-06-17 incident, topic 12476). The fix records the load ratio on each unresponsive tick into a small fixed window (`loadSampleWindow = 6`, ~60s) and treats the box as starved if the **windowed max** exceeds the threshold. The window is cleared when the failure streak resets (server recovered), so stale high readings can't over-defer a later episode. Files: `src/lifeline/ServerSupervisor.ts` (the guard + 4 new fields + the deferral log line now reports the sustained ratio), `tests/unit/supervisor-cpu-starvation-defer.test.ts` (updated the test that encoded the old instantaneous behavior; added dip-protection, sustained-easing, and window-reset cases).

## Decision-point inventory

- `ServerSupervisor.deferRestartForCpuStarvation()` — **modify** — the starvation SIGNAL feeding the restart authority is changed from instantaneous to a sustained windowed-max reading. No new authority added; the existing restart decision (and its hard cap) is unchanged in structure.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Mapped to this domain, "over-block" = deferring a restart that genuinely should happen. The change makes deferral *more* likely (it holds off restarting while recent load was high). The bounded risk: a server that is genuinely hung (frozen event loop) AND happens to be on a box that was busy in the last ~60s will wait up to the full window (~60s) longer before the windowed max falls — and in the worst case waits for the ~5-minute hard cap, which is unchanged and still force-restarts. So the maximum added delay before a truly-hung server restarts is bounded by the existing hard cap; the change never *prevents* a restart, only delays it under recent-high-load — which is the intended, safe direction.

## 2. Under-block

**What failure modes does this still miss?**

A box that is chronically starved for longer than the ~5-minute hard cap will still force-restart at the cap, which on a sustainedly-overloaded machine is itself unhelpful (restarting never cures starvation). This fix addresses the dominant observed failure (the sub-cap dip-triggered restarts at "10 checks") but does NOT change the hard-cap behavior. Making the hard cap escalate-instead-of-restart under sustained starvation is a genuine follow-up. <!-- tracked: topic-12476 --> The real cure for chronic starvation is reducing machine load (surfaced to the operator separately).

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The supervisor is the correct owner of the server-restart decision (process lifecycle). The starvation check is a *detector signal* feeding that authority; this change improves the signal's quality (smoothing out single-sample noise) rather than adding a new authority. It reuses the existing injectable `loadRatioProvider` / `cpuStarvation` primitive — no re-implementation of load reading.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?** (`docs/signal-vs-authority.md`)

Compliant. The brittle part (reading load) is a detector; this change makes that detector *less* brittle by replacing an instantaneous reading with a sustained windowed one. The restart authority (the supervisor's deterministic lifecycle policy — appropriate for this tightly-constrained domain) is unchanged. No new brittle blocker is introduced; the existing one is smoothed.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

- It interacts only with `evaluateUnhealthyServer()`, which calls it once per unresponsive tick. No new timers, no concurrency. The window is single-threaded supervisor state.
- The hard-cap early-return is preserved and runs *after* the sample is recorded, so the window stays accurate for logging.
- The window-reset detection keys on `consecutiveFailures` not strictly increasing (it strictly increases within a streak; a new episode restarts at the threshold) — verified against all reset sites; deferral is only consulted at/above threshold, so the `<=` reset test is correct.
- SleepWakeDetector uses the same `cpuStarvation` ratio but keeps its own state — no shared mutable state touched.

## 6. External surfaces

**Anything visible to other agents/users/systems? Timing/state dependencies?**

Only the supervisor's own log line changes wording (now reports the sustained ratio + window). No API, no message, no cross-agent surface. Behavior is purely local process-lifecycle. The only timing dependency is the existing 10s health-check cadence, which the window is sized against (6 samples ≈ 60s).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The supervisor watches the server on its OWN machine; CPU starvation and restart decisions are inherently per-machine. There is no cross-machine state to replicate and nothing to proxy on read — each machine's supervisor independently judges its own load. No one-voice/transfer/URL concerns (no user-facing notice, no durable shared state, no generated link).

## 8. Rollback cost

**If wrong in production, what's the back-out?**

Low. Single-file logic change behind the existing injectable provider. Back-out = revert the commit (a hot-fix patch release). No data migration, no state repair — the supervisor holds only in-memory transient state (the load window), which resets on the next boot. Worst-case failure mode of the fix itself (over-deferral) is bounded by the unchanged ~5-minute hard cap.

---

## Phase 5 — Second-pass review (required: restart/recovery path)

**Reviewer:** independent reviewer subagent (general-purpose), 2026-06-17.

**Verdict: Concur with the review.**

Independent audit findings:
- **Windowing correctness:** the counter strictly increases within a streak because `consecutiveFailures++` precedes every `evaluateUnhealthyServer()` call (both failure callsites), so the `<=` reset-detection correctly distinguishes a continuing streak (no clear) from a new episode (clear); it cannot false-clear mid-streak.
- **Empty-array / -Infinity:** safe — a sample is pushed unconditionally before every `Math.max(...)`, even right after a reset-to-`[]`.
- **Safety valves all preserved:** dead process restarts instantly (early return before the guard); hung server on an idle box restarts promptly (window fills with low samples → max < threshold); the ~5-min hard cap still force-restarts.
- **Signal vs authority:** compliant — improves a detector signal (instantaneous → sustained windowed-max), no new brittle authority.
- **Direction:** only ever makes restart *less* aggressive; max added delay for a truly-hung-on-recently-busy box is bounded by the unchanged hard cap.
- **Test quality:** the new tests genuinely fail against the old instantaneous code (the dip-sample and first-eased-tick cases).
