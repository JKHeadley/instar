# Side-Effects Review — Per-agent ResourceLedger, Phase A (durable rate-limit events)

**Version / slug:** `resource-ledger-phase-a`
**Date:** `2026-06-03`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required`

## Summary of the change

Phase A of `docs/specs/per-agent-resource-ledger.md`: a durable, read-only store
for rate-limit events, so breaker trips + session-sentinel detections survive
restarts (today they're process-local and vanish). New:
- `src/monitoring/ResourceLedger.ts` — SQLite store (`rate_limit_events`),
  TokenLedger pattern (NativeModuleHealer/WAL/registerSqliteHandle), swallow-on-write.
- `src/monitoring/ResourceLedgerPoller.ts` — event-driven; subscribes to the
  breaker observer (+ optional RateLimitSentinel) and writes one row per emission.
- `src/core/LlmCircuitBreaker.ts` — added a minimal `onTrip`/`onRecover` observer
  (emit in `onRateLimited` and on open→closed `onResolved`).
- `src/server/AgentServer.ts` — construct ledger (own try/catch) + start poller
  (breaker = `getLlmCircuitBreaker()`); inject into route ctx; stop on shutdown.
- `src/server/routes.ts` — `GET /resources/rate-limits` (503 on null ledger).
- `src/config/ConfigDefaults.ts` — `monitoring.resourceLedger.enabled` (default on).
- `src/scaffold/templates.ts` — CLAUDE.md Capabilities entry (Agent Awareness).

## Decision-point inventory
- `LlmCircuitBreaker.onRateLimited / onResolved` — **modify (additive emit only)** —
  fire observer callbacks; no change to gating/state logic.
- `ResourceLedger` writes, route, poller, config default, template — **add**.

## 1. Over-block
No block/allow surface — not applicable (read-only observability).

## 2. Under-block
No block/allow surface. (Phase A captures breaker trips + sentinel detections; it
does not claim to capture every provider 429 — the breaker trip is the canonical
account-level signal, sentinel detections are counted separately by `source`.)

## 3. Level-of-abstraction fit
Correct. The ledger is a recorder, not an authority; it FEEDS the read-only
`/resources` surface and never gates. The breaker observer is a pure side-channel
on a component that DOES hold gating authority — see §4.

> CI-fix addendum (full-suite caught two regressions the local subset missed,
> both no-behavior-change): (a) the new `/resources` route prefix was unclassified
> in `CapabilityIndex` — added a read-only `resourceLedger` capability entry
> (enabled only when `ctx.resourceLedger` exists); (b) `ResourceLedger.ts`
> registers a SQLite handle so it was added to the `SqliteRegistry-wiring` test's
> `LONG_LIVED_STORES` allowlist. No new surface; purely discoverability/test wiring.

## 4. Signal vs authority compliance
**Required reference:** docs/signal-vs-authority.md
- [x] No — this change has no block/allow surface of its own.

The one sensitive point: `LlmCircuitBreaker` holds real blocking authority (it
gates ALL LLM work). I added an *observer* to it, NOT logic that affects gating.
Safety properties, all tested (`tests/unit/llm-circuit-breaker-observers.test.ts`):
- `emitTrip`/`emitRecover` iterate listeners inside a per-listener `try/catch`, so
  a throwing observer **cannot** propagate into the breaker — verified by a test
  that registers a throwing listener and asserts `onRateLimited` doesn't throw and
  `tripCount` is still correct.
- The emit happens AFTER all state mutation (last line of `onRateLimited`; end of
  `onResolved`), so an observer can never see/affect an intermediate state.
- The 30 existing breaker tests still pass unchanged — no behavioral drift.

## 5. Interactions
- **Shadowing/double-fire:** none. The observer is additive; the breaker's
  acquire/onRateLimited/onResolved behavior is byte-identical to before.
- **Races:** the poller's per-source `seq` + the ledger's `(source,ts,seq)` id +
  `INSERT OR IGNORE` make writes idempotent; a replay can't double-count.
- **Lifecycle:** ledger constructed in its OWN try/catch in AgentServer (cascade
  isolation — a failure can't 503 TokenLedger/FeatureMetricsLedger); poller
  `stop()` unsubscribes the breaker observer + the ledger closes on shutdown.
- **Feedback loops:** none — observe-only.

## 6. External surfaces
- New route `GET /resources/rate-limits` (additive; Bearer-auth; read-only).
- Persistent state: a new `server-data/resource-ledger.db` per agent. No schema
  change to existing DBs. Naturally bounded (~hundreds of events/day) — no
  retention needed for `rate_limit_events` (the high-frequency `resource_samples`
  table that WILL need retention is Phase B, not in this PR).
- Config: `monitoring.resourceLedger.enabled` default true (ships ON — event-driven,
  negligible cost; `false` leaves the ledger null and the route 503s).

## 7. Rollback cost
Pure additive code + a new DB file. Revert and ship a patch; the orphaned
`resource-ledger.db` is harmless (nothing else reads it). No migration of existing
state, no agent-state repair, no user-visible regression.

## Conclusion
Complete, working Phase A with all three test tiers green (unit store+emitter+poller
incl. a real-breaker→real-ledger wiring test; integration route 200/503; e2e
"feature is alive" 200 on the real AgentServer init path). The only authority-
adjacent edit (the breaker observer) is provably unable to affect gating. CPU/mem
sampling + retention + the unified `/resources` snapshot + dashboard are Phase B
(specced, not in this PR). Clear to ship.

## Evidence pointers
- `tsc --noEmit` clean; vitest green: `ResourceLedger.test.ts` (6),
  `ResourceLedgerPoller.test.ts` (4), `llm-circuit-breaker-observers.test.ts` (4),
  `llm-circuit-breaker-wait.test.ts` (30, unchanged),
  `resources-rate-limits-routes.test.ts` (2), `resources-rate-limits-lifecycle.test.ts` (3).
