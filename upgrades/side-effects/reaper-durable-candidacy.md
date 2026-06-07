# Side-Effects Review - Durable reaper candidacy (A)

**Version / slug:** `reaper-durable-candidacy`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

The SessionReaper's `obs` candidacy map (candidateSince/consecutive/lastFrame/lastTranscript/reapPendingSince) was in-memory only, so the multi-minute idle clock reset on every server restart. On a box restarting ~every 10 min (SleepWake-under-load churn, see fix B), the 45-min reap threshold was never reached → the reaper (correct after #969, flagging 11 idle sessions) reaped 0. Adds optional `loadCandidacy`/`saveCandidacy` deps: restore the map on construct (dropping `reapPendingSince`), persist after each tick. Server wires them to `.instar/state/session-reaper-candidacy.json`.

## Decision-point inventory

- `SessionReaperDeps.loadCandidacy?()` / `saveCandidacy?(map)` (new, optional).
- Constructor: restores obs, clearing `reapPendingSince` per entry.
- `tick()`: calls `persistCandidacy()` at the end of the try (after obs updates).
- `Obs` interface exported (for the server's typed file IO). server.ts: JSON file in stateDir.

## 1. Behavior change / gating

The only change: the idle-candidacy clock survives restarts. It does NOT bypass any gate — every tick still runs the full classifier (all-clear: positive-idle + transcript-flat + 8h-silent + guards) AND render-stasis (live frame vs restored lastFrame) before reaping. So a session that changed during the restart gap resets candidacy. Reaper stays opt-in + dry-run-first.

## 2. Over/under-signal

OVER-reap risk: restoring a stale candidacy that reaps a now-active session. Mitigations: (a) `reapPendingSince` dropped on load → no insta-kill from stale pending; (b) per-tick all-clear re-gate → an active session reads not-all-clear → candidacy resets (line 656/665 reset paths); (c) render-stasis → if the frame differs from the restored lastFrame, frameStatic=false → candidateSince resets to now; (d) GC drops obs for vanished sessions. So restored candidacy only matures a reap for a session that is STILL continuously idle. UNDER (never reaps) is the bug fixed.

## 3. Blast radius

One small map persisted as JSON (≤ a few sessions × a 200-line frame). Read once on construct, written once per tick (120s). No API/route, no schema migration. Optional deps → absent ⇒ in-memory (prior behavior) ⇒ zero change for any caller that doesn't wire them.

## 4. Failure modes

Both load and persist are wrapped (`@silent-fallback-ok`): a corrupt/missing/garbage file ⇒ start in-memory; a failed write ⇒ clock resets next restart (prior behavior). Malformed entries skipped (typeof candidateSince check). Never throws into tick().

## 5. Migration parity

No agent-installed file/config/skill/CLAUDE.md change — internal reaper state, wired in server.ts; effective on next server start. The state file is created on first tick. Reaper remains opt-in (enabled:false default).

## 6. Scope honesty (what this is NOT)

- Fix A of the operator's A+B pair. Makes the reaper reclaim DESPITE restart churn; it does NOT fix the churn (that's B — the SleepWake-under-load misfire + tunnel-restart timeouts, the deeper root).
- Does NOT change reap thresholds or what counts as idle.

## 7. Causal autopsy

Origin: **latent**. The candidacy map has been in-memory since the reaper was written — fine on a stable server, but a latent fragility under restart churn. It only became the blocker once #969 made the reaper correctly identify idle sessions AND the box began restarting every ~10 min (SleepWake-under-load, the same instability as the laptop-eventloop-stall finding). 2026-06-07 grounding: 6 restarts in 70 min, reaper saw 11 all-clear, reaped 0 because candidateSince reset each restart. No prior PR regressed it; the durability was simply never needed until the churn exposed it.
