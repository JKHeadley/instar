## What Changed

Fixed a hot-spin loop in the idle-session cleaner. When a session sat idle past its bound-idle threshold but was PROTECTED by a keep-reason (an open commitment, a recent user message), the cleaner re-attempted the kill every 5 seconds forever — the ReapGuard vetoed it every time, but the idle clock was never reset, so it just re-fired. That single loop wrote thousands of "skipped" records a day and grew one agent's reap-log to 132MB, and it was the real driver behind the "my sessions keep swapping/restarting" symptom.

The shipped `AgeKillBackoff` P19 back-off primitive (which already fixed the *identical* loop one branch over — the age-gate) is now generalized into a shared `VetoedKillBackoff` and wired into the idle-zombie branch too. A vetoed idle-zombie kill now BACKS OFF (default 30-minute cooldown) instead of re-firing every tick, logs once per episode instead of every 5s, and — after 6 consecutive vetoed episodes on a genuinely-stuck session — raises exactly ONE flood-guarded attention item so the stuck session is surfaced rather than silently spun on.

**This never changes WHICH sessions are killed — only how OFTEN a kill the guard already vetoed is re-attempted.** A session with no keep-reason still dies on the first attempt. The KEEP-guard remains the sole authority.

Ships LIVE on development agents and DARK on the fleet (`monitoring.idleKillVetoBackoff`, `enabled` resolved by the dev-agent gate). Per-machine by design. `enabled: false` fully reverts to the prior per-tick behavior with no persisted state to unwind.

## What to Tell Your User

Nothing changes for you unless you were seeing a session "keep restarting/swapping" or a runaway audit log. On a development agent this fix runs live now: idle sessions that are protected (open commitment / recent message) are re-checked on a slow cadence instead of hammered every 5 seconds, so the reap-log stops flooding and the CPU churn behind it goes away. If a session is *genuinely* stuck (permanently vetoed for hours), you'll now get ONE plain heads-up on your attention queue naming it — instead of thousands of silent log writes. On the wider fleet it ships off until it's proven out on the dev agent.

## Summary of New Capabilities

- `monitoring.idleKillVetoBackoff` config knob — `cooldownMs` (default 30m), `escalateAfterEpisodes` (default 6). `enabled` is governed by the dev-agent gate (live on dev, dark on fleet); set it explicitly to force on/off. `cooldownMs: 0` is enabled-but-no-cooldown, not a disable.
- A P19 breaker that raises ONE flood-guarded HIGH attention item ("Session X is permanently vetoed from idle-zombie cleanup") after N consecutive veto episodes — surfacing a genuinely-stuck session instead of spinning silently.

## Evidence

- New `tests/unit/vetoed-kill-backoff.test.ts` (20) + `tests/unit/session-manager-idle-veto-backoff.test.ts` (14) cover the value-shape migration, reason-key stale-reprieve, once-per-episode logging, the disabled contract, single-guard-eval, the map-leak eviction, `cooldownMs:0` semantics, and the breaker.
- Regression: `AgeKillBackoff.test.ts` (7) + `age-kill-backoff-integration.test.ts` (4) green (the age-gate behaves identically). 45/45 feature+regression; `tsc --noEmit` exit 0.
- Side-effects review + independent second-pass review: `upgrades/side-effects/session-respawn-thrash-elimination.md`.
- Spec: `docs/specs/session-respawn-thrash-elimination.md` (converged, cross-model reviewed) + `docs/specs/session-respawn-thrash-elimination.eli16.md`.
