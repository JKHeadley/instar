# Side-Effects Review — Agent hard-sleep SleepController (Stage B, slice 1)

**Version / slug:** `agent-hard-sleep-controller`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required — dark + dry-run + signal-only; the module holds no blocking authority and never stops a process`

## Summary of the change

Adds the DECISION half of agent hard-sleep: `SleepController` (pure `evaluateSleep`
+ a thin ticking class) decides whether a deeply-idle agent may drop to near-zero
footprint, applying every safety guard (held multi-machine lease / in-flight work /
imminent scheduled job). A shared `AgentActivityState` idle signal is bumped at the
inbound chokepoint (`/internal/telegram-forward`). Wired into the server (off +
dry-run by default), exposed read-only at `GET /sleep`, audited to
`logs/agent-sleep-events.jsonl` on decision transitions. Files: new
`src/monitoring/SleepController.ts`, `src/monitoring/AgentActivityState.ts`;
config `monitoring.agentSleep` (types.ts + ConfigDefaults.ts); wiring in
server.ts + AgentServer.ts + routes.ts; CapabilityIndex classification.

## Decision-point inventory

- `evaluateSleep` (new decision) — add — the awake/idle-shallow/keep-awake/would-sleep verdict with guards.
- `SleepController` audit + (live-only) sleep-request — add — transition-only audit; `requestSleep` is unwired in this slice (no consumer).
- `GET /sleep` route — add — read-only verdict surface (503 when unwired).
- Inbound chokepoint — pass-through — adds a non-blocking `markInbound()` side-call.

---

## 1. Over-block

No block/allow surface over any message or user action. The verdict is advisory;
in this slice nothing consumes a would-sleep (the `requestSleep` consumer is the
next slice). Over-block not applicable.

## 2. Under-block

The decision could, in principle, say "would-sleep" when it shouldn't (e.g. the
in-flight signal is approximate in this slice — it reads `currentInboundByTopic`
but not yet the relay/forward queue or the scheduler's next-fire). This is harmless
here: dry-run never acts on the verdict, and the next slice wires the remaining
in-flight + scheduler-wake signals BEFORE the mechanism that actually sleeps. The
guards that ARE wired (sessions, lease, recent activity) are exact.

## 3. Level-of-abstraction fit

Correct. The decision is a pure, exhaustively-tested function; the controller is a
thin cadence wrapper that mirrors the existing dark monitors (SessionReaper,
AgentWorktreeReaper) — same dark + dry-run discipline, same audit-on-transition,
same `snapshot()` route shape. It deliberately does NOT contain the mechanism
(supervisor stop / lifeline respawn); that is a separate slice so the decision can
be validated first.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a SIGNAL (a verdict + audit) with no blocking
  authority over any message or process. In live mode (the mechanism slice) the verdict
  would feed the supervisor handshake, but even then "sleep" is gated like the
  SessionReaper (positive proof + KEEP-on-ambiguity), not a brittle detector with
  kill authority.

## 5. Interactions

- **Shadowing:** none. `GET /sleep` is a new route; the inbound `markInbound()` is a
  fire-and-forget side-call after the boot guard and does not alter the
  forward's control flow or response.
- **Double-fire:** none. The controller is the only consumer of `AgentActivityState`.
  No other monitor sleeps a server.
- **Races:** the controller ticks on a single timer (unref'd); `AgentActivityState`
  is plain in-memory single-writer-per-event. The `sleepRequested` latch prevents
  repeated requests within a would-sleep episode.
- **Feedback loops:** none — dry-run writes only an audit log it never reads back.

## 6. External surfaces

- **Other agents / install base:** pure additive source + a default-off config
  block (auto-applied via ConfigDefaults; code reads with `?? default` so an agent
  whose config lacks the block behaves identically — OFF). No agent-installed-file
  change requiring a CLAUDE.md/hook migration; the route is internal observability
  (classified in CapabilityIndex like /worktrees/agent-reaper), so no template/
  awareness section is required for this dark slice.
- **External systems:** none.
- **Persistent state:** one best-effort append-only audit log
  (`logs/agent-sleep-events.jsonl`), written only on decision transitions.
- **Timing:** one unref'd 60s timer when enabled; never started when disabled.

## 7. Rollback cost

Pure additive code + a default-off config block. Revert the commit → the controller,
route, config, and audit disappear; nothing else changes. No migration, no agent
state repair, no user-visible behavior (it never acted).

## Conclusion

This review confirmed the slice is observability-only: a tested decision function
with all safety guards, shipped dark + dry-run, with no authority and no mechanism.
It is the safe foundation the next (mechanism) slice will build on, and the dry-run
audit is exactly what makes that next slice safe to wire. Clear to ship; validate by
watching `GET /sleep` + the audit log on a real idle agent before enabling.
