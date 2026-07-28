# Side-effects — SleepWakeDetector recurring-drift guard (gap #3 / CMT-1563)

## What changed (3 files)

- `src/core/SleepWakeDetector.ts` — new config `recentDriftWindowMs` (default 300000) +
  `recentDriftLoadFloor` (default 1.0); new state `lastShortDriftAtMs`; a new suppression branch
  in `start()` (after the load guard, before the cooldown) that suppresses a SHORT drift recurring
  within the window while `loadRatio > recentDriftLoadFloor`. Reuses the existing `cpu-starvation`
  suppression reason — the stats/telemetry type is unchanged.
- `src/core/types.ts` — `config.monitoring.sleepWake` gains the two optional knobs (mirrors the
  existing `maxLoadRatio` plumbing; no ConfigDefaults change, no migration).
- `src/commands/server.ts` — the production `new SleepWakeDetector({...})` boot site forwards the
  two new knobs from `config.monitoring.sleepWake`.

## Behavioral side-effects

- **On a moderately-loaded host (loadRatio in the 1.0–1.5 band):** a short timer drift that recurs
  within 5 min of a prior short drift no longer emits a `wake` — so it no longer triggers the
  wake-recovery cascade (tunnel restart / Slack reconnect / mesh-lease churn / topic failover). This
  is the fix for the 2026-06-15 multi-machine UX cascade.
- **No change** on a light/idle host (ratio ≤ 1.0): repeated short drifts still emit (the existing
  "genuinely-isolated drifts both emit" behavior is preserved — verified by the unchanged tests).
- **No change** for long sleeps (≥ `longSleepFloorSeconds`): always emitted, recovery preserved.
- **No change** for an isolated short drift (no prior drift in the window): still emits.
- The wake-reaper's cumulative-sleep accounting is unaffected — suppressed drifts were already
  excluded from `wakeHistory`, and this branch suppresses the same way.

## Risk + rollback

- HIGH-risk surface (session-lifecycle / recovery trigger). Fail-safe direction: the branch only
  ADDS suppression to a SHORT drift on an OVERSUBSCRIBED host; it can never suppress a real long
  sleep or change light-host behavior.
- Rollback lever: `config.monitoring.sleepWake.recentDriftWindowMs: 0` disables the guard with no
  logic redeploy (restores exactly today's behavior).

## Tests

- `tests/unit/sleep-wake-starvation-guard.test.ts` — new `describe('recurring-drift guard for the
  moderate-load band')` with 5 cases (band-suppress, light-host-emit, isolated-emit, disable-lever,
  long-sleep-exempt). Full sleep-wake unit suite: 39/39 green. tsc clean on the touched files.

## Migration parity

The fix ships in the class default, so every agent gets it on update (the boot site reads optional
config but the default is in the constructor). No `.claude`/hook/skill/CLAUDE.md template change is
required — this is an internal monitoring guard, not an agent-facing capability or route.
