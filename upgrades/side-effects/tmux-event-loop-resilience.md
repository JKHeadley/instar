# Side-Effects Review — tmux Event-Loop Resilience (Increment 1)

**Slug:** `tmux-event-loop-resilience` · **Tier:** 2 (converged + approved spec
`docs/specs/tmux-event-loop-resilience.md`). Touches `PostUpdateMigrator` (a
config-strip migration), so the tier signal flags `belowFloor` — accepted: the
PostUpdateMigrator touch is a dev-gate cleanup strip (removes a stale persisted
`enabled:false` so the dev-gate resolves live-on-dev), fully reversible, no
external surface.

## Summary of the change

The server's frequent synchronous `tmux` calls blocked the single event loop; a
slow shared tmux server froze the loop ~15s, dropping the dashboard websocket and
getting misread as host sleep. Increment 1: (A) an async, timeout-bounded tmux
hot path with cache-served dashboard/session reads; (B) an in-flight-sync-op
marker as the block-vs-sleep discriminator (in-process for SleepWakeDetector,
cross-process via a mirror file for ServerSupervisor); (C) a signal-only
`DegradedTmuxGuard` that surfaces a persistently slow tmux without ever killing
it. All three are dev-gated: LIVE on a development agent, DARK on the fleet.

## 1. Over-block / false signal

`DegradedTmuxGuard` is signal-only — it raises ONE deduped attention item and
never kills, restarts, or reaps anything, so a false degradation signal costs at
most one surfaced notice. It is load-gated (suppressed when per-core load is high
— that is expected slowness, not a tmux fault) and requires N-cycle corroboration
(a single hiccup never raises an episode), with episode dedup + age-escalation.
The in-flight marker can only SUPPRESS a wake / DEFER a restart when affirmatively
present, in-flight, and non-stale — a false positive there fails toward the SAFE
direction (keep the session alive / let a genuinely-dead server restart).

## 2. Under-block / missed signal

A real freeze the marker doesn't cover is still caught: SleepWakeDetector's
existing cpuBlockBusyRatio path (CPU-spin blocks) is unchanged, and the marker
adds the ~0-CPU I/O-wait case #1240 couldn't see. The marker self-heals via a
2×timeout TTL so a leaked depth can never permanently blind sleep detection. The
supervisor defer is hard-capped (`starvationRestartThreshold`) so a stuck
in-flight marker can never wedge the restart path forever — it gives up loudly.

## 3. Blast radius / fail-open

Every failure path fails toward SAFE and is non-silent (no-silent-fallbacks
ratchet enforced): a tmux call that times out maps to INDETERMINATE, never to
"absent" — `isSessionAliveAsync` returns `'indeterminate'` (never `false`) on a
timeout, so a slow tmux can NEVER cause a live session to be reaped (the
line-2352 regression the tri-state guards). The cross-process marker reader is
fail-OPEN: an absent/unparseable mirror ⇒ null ⇒ the supervisor proceeds to
restart a genuinely dead server. The mirror writer is best-effort: an unwritable
mirror never breaks a tmux call. `DegradedTmuxGuard` uses a fixed-capacity
modulo-write ring (Bounded Accumulation — 10,000-sample burst-invariant test
proves the ring length never exceeds windowSize), so it cannot grow memory under
a flood.

## 4. Signal vs authority

The only blocking authority introduced is the supervisor restart-DEFER, and it is
bounded (hard cap + TTL + fail-open) and additive to the existing
`deferRestartForCpuStarvation` (the `||` keeps the CPU side-effect — verified by
test). The wake-handler amplifier guard short-circuits a marker-covered wake and
bounds the cascade's tmux re-validation (async 9000+SIGKILL); it never silences a
genuine recovery. `DegradedTmuxGuard` holds zero authority — it observes and
surfaces only.

## 5. Interactions

Reuses the existing `'event-loop-block'` WakeSuppressionReason + StallEvent (no
new telemetry shape). The async hot-path twins coexist with the legacy sync
methods behind `tmuxAsyncEnabled` (off ⇒ byte-identical legacy behavior — the e2e
observable-equivalence test). `getCachedRunningSessions()` is the cache the
request routes (GET /status et al.) now read; the non-request consumers
(JobScheduler, WebSocketManager, AutoUpdater) intentionally keep the live read
(documented residual, Increment 2 territory). Per-agent socket isolation is
explicitly OUT of Increment 1 (Increment 2).

## 6. Rollback

Each of the three flags is independently disable-able in `.instar/config.json`
(`monitoring.tmuxResilience.asyncHotPath.enabled`,
`monitoring.tmuxResilience.inFlightMarker.enabled`,
`monitoring.degradedTmuxGuard.enabled`) — set to `false` to revert that layer to
the pre-change behavior. The async hot path falls back to the sync path; the
marker branch goes inert; the guard stops observing. The migration strips only a
default-shaped persisted `false`, never an explicit operator `true`/`false`.
Config defaults OMIT `enabled` so the dev-gate (resolveDevAgentGate) governs:
fleet = dark, dev = live.
