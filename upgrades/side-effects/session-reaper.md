# Side-Effects Review — SessionReaper

Spec: `docs/specs/SESSION-REAPER-SPEC.md` (v2 CONVERGED + ratified). Build branch `build/session-reaper`.

## What changes for a deployed agent

- A new monitor (`SessionReaper`) is constructed and started at server boot. **Default OFF + dry-run** (`monitoring.sessionReaper.enabled:false, dryRun:true`), so deployed agents get **no behavior change** until an operator opts in. New config block arrives via the standard `ConfigDefaults`/`applyDefaults` migration; operator-set values are never overwritten.
- New read-only endpoint `GET /sessions/reaper` (503 when unwired, 200 snapshot otherwise).
- `SessionManager` gains `terminateSession()` (single-writer CAS), `isRelayLeaseActive()`, and `markReaping/clearReaping/isReaping`. The existing idle-kill now funnels through `terminateSession` and skips reaping-leased sessions; `killSession` shares the CAS guard and now sets `endedReason` (its event emissions are unchanged — still no `sessionComplete`).
- The zombie-kill recovery veto (`activeRecoveryChecker`) is recomposed to include the socket + silence sentinels (previously compaction + rate-limit only) — a strict superset; nothing is dropped.

## Over/under-block analysis (the hard requirement)

The reaper must never reap a working session. Safety rests on positive evidence, not absence of activity:
- **Under-block (fails to reap a genuinely idle session):** acceptable — the existing 15m/4h idle-kill still runs; the reaper is additive pressure relief.
- **Over-block (reaps a working session):** the failure that matters. Mitigations: (1) requires a *positive* turn-complete idle-prompt signal; (2) render-stasis — pane byte-identical across all confirm ticks; (3) process + transcript must be quiet, and any *unresolvable* signal (no `claudeSessionId`, Codex/missing/rotated transcript, uninspectable process) forces KEEP, never "quiet"; (4) hysteresis; (5) two-phase reap with a final-grace re-check that aborts on any frame change; (6) Normal pressure tier reaps nothing; (7) bounded per-tick/per-hour budget; (8) auto-disable to dry-run on any ambiguous/failed reap; (9) ships OFF + dry-run.

## Level-of-abstraction / signal-vs-authority

Signals carry confidence and only *recommend*; kill authority sits behind the budget + dry-run + single-writer `terminateSession` CAS + auto-disable. The reaper computes a verdict; it does not own an unbounded kill.

## Interactions

- Composes with (does not fight) existing watchdogs: gate G defers to any recovery-in-flight (now incl. socket/silence); disjoint from OrphanProcessReaper (untracked procs) and SessionWatchdog (active-but-stuck); shares the single-writer kill path with the idle-kill so no double-kill / double-event.
- Pressure source is freemem-tiered for v1 (advisory; macOS under-reports). Crucially, an over-eager pressure tier can only reap a *genuinely-idle* session sooner — it cannot cause a working session to be reaped, because the classifier protects working sessions independent of tier.

## Rollback

Set `monitoring.sessionReaper.enabled:false` (the default) — fully inert. No data migration; `endedReason` is additive/optional. Revert the branch to remove code; no persisted state needs cleanup beyond an optional `state/session-reaper.json` (absent unless restart-durability is later wired).

## Tests

3-tier: unit (transcript prober, terminateSession CAS, classifier incl. every false-reap vector, config/migration), integration (`/sessions/reaper` + dry-run), e2e (feature-alive + dangerous cases). Wiring-integrity guards the construct→start→pass chain. Live test-as-self on a real in-flight build + a real Codex session precedes merge.
