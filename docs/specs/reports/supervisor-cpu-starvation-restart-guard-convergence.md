# Convergence report — Supervisor CPU-starvation restart guard

**Spec:** `docs/specs/supervisor-cpu-starvation-restart-guard.md`
**Author:** echo
**Date:** 2026-05-29
**Iterations:** 2 (self-review; fast-tracked — see note)

## Fast-track note (transparency)

URGENT fleet-wide bug: the overload-driven server restart loop drops user
messages (the "Session restarting, message never lands" symptom Justin reported
live, topic 15160, and approved fixing — "go ahead and restart and apply the
fix" + his approval of building the guard). Per the standing directive to
auto-fix-and-deploy urgent fleet bugs, the multi-agent `/spec-converge` panel
was fast-tracked to a constrained self-review. The change is bounded, additive,
and strictly safety-improving (it can only DEFER a restart it would otherwise
have done, and only while genuinely CPU-starved, up to a hard cap). Disclosed
here and to Justin.

## Material questions resolved

1. **Could deferring strand a genuinely-hung server?** No. The defer fires only
   while `loadRatio > 1.5` AND below the hard cap `starvationRestartThreshold`
   (30 checks ≈ 5min). Past the cap it force-restarts regardless of load. A dead
   process restarts immediately (unchanged). The next healthy tick resets the
   counter, so the defer is self-clearing.

2. **Right load signal?** `loadavg[0] / cpuCount > 1.5` — identical to the
   SleepWakeDetector CPU-starvation classification, now extracted into a shared
   `cpuStarvation` module so the fleet has one definition. The helper returns 0
   on any read error, so a failure to read load never trips the defer.

3. **Default ON vs flag?** ON. The guard only changes the alive+unresponsive
   +starved case, where the old behavior (bounce) was counterproductive and
   message-dropping. Gating it OFF would leave the restart loop live fleet-wide
   for no safety benefit. No new config knob needed; the thresholds are class
   constants (so all agents get them with no migration), and the load source is
   injectable purely for testing.

4. **Testability.** The two duplicated health-failure branches were extracted
   into one `evaluateUnhealthyServer()`, and the load source is injected
   (`loadRatioProvider`), so the REAL decision method is unit-tested (not a
   mirror) across all branches, plus a source wiring guard that both failure
   paths route through it.

## Outcome

Converged. No open blocking questions. Unit tests green (real method + pure
helper). No migration (pure `src/`). The durable capacity cure remains the
mac-mini migration; this guard prevents the laptop from worsening overload.
