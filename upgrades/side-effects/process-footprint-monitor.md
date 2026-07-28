# Side-Effects Review — Process-footprint monitor

**Version / slug:** `process-footprint-monitor`
**Date:** `2026-06-27`
**Author:** `echo`
**Tier:** 1 — a NEW observe-only monitor + a read-only route. Ships DARK (developmentAgent
gate). No authority, no gate, no deletion, no mutation; it only READS process metadata
and exposes a status. The threshold heads-up is opt-in and its sink is unwired in this
increment (measure-first).

## Summary of the change

Adds `ProcessFootprintMonitor` — the per-machine process-COUNT measurement missing before
the 2026-06-26 resource-exhaustion kernel panic (the ResourceLedger samples CPU%/RSS but
not process count). On an interval it counts agent-relevant processes (agent CLIs / MCP
servers via the shared `MCP_PROCESS_SIGNATURES` / other node), keeps a bounded rolling
window for a trend, and exposes `GET /resources/footprint`. Files:
`src/monitoring/ProcessFootprintMonitor.ts` (new — pure classifier + sampler + a
`ps`-backed scanner funneled through `withSyncOp`), `src/server/AgentServer.ts` (construct
+ start, dev-gated; null when disabled), `src/server/routes.ts` (the read-only route +
ctx type), `src/core/types.ts` (config), `src/scaffold/templates.ts` +
`src/core/PostUpdateMigrator.ts` (awareness). Tests: 11 unit + 3 integration + 4 e2e.

## 1. Over-block / 2. Under-block

**No block/allow surface — not applicable.** The monitor never gates, kills, or throttles.
The closest failure is a wrong reading: a throwing `ps` scan fails safe (keeps the last
sample, never crashes `sample()`); classification is best-effort (a miscount only changes
a number, never an action). Both sides of the classifier and the alert latch are unit-tested.

## 3. Level-of-abstraction fit

Correct layer. It sits beside the ResourceLedger as read-only observability, constructed in
`AgentServer` like the other monitors and exposed via a `/resources/*` route. The pure core
(classifier, sample builder, trend, alert latch) is fully injectable/fake-testable; only the
production `ps` scanner touches the host.

## 4. Signal vs authority compliance

Pure SIGNAL. The status is consumed by a human/dashboard, not by any gate. The optional
threshold heads-up only ever ADDS one de-duplicated attention item (per episode, with
hysteresis) — it carries zero blocking authority and is OFF by default.

## 5. Interactions

- **Sampling cost:** one `ps` scan per multi-minute interval, funneled through `withSyncOp`
  (the in-flight marker sees the bounded blocking spawn). Dark by default → zero fleet cost.
- **Alert latch:** one heads-up per threshold-crossing episode; re-arms only after the count
  drops below 90% of the threshold (hysteresis) — no flapping. Tested both sides.
- **Disabled = null:** when the dev-gate/config resolves disabled, the monitor is not
  constructed → the route 503s (matches the ResourceLedger contract; e2e-tested).

## 6. External surfaces

- **New route** `GET /resources/footprint` (Bearer-gated, read-only; POST → 404). No new
  external call beyond the local `ps` scan. No new credential.
- Config: `monitoring.processFootprintMonitor` (enabled/sampleIntervalMs/windowSamples/
  alertThreshold/alertEnabled). `enabled` undefined rides the developmentAgent gate. No
  config MIGRATION needed (absence resolves via the gate; `?? defaults` cover the rest).

## 7. Rollback

Pure additive code + one config block + docs. Reverting the commit removes the monitor and
the route entirely. Dark default means no agent runs it until explicitly enabled.

## Known follow-up (tracked, not in this increment)

The threshold heads-up's `emitAttention` sink is left unwired (the alert is opt-in and OFF
by default — measure-first). Wiring it to the aggregated attention surface is increment 2.
