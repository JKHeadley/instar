# Side-Effects Review — Cross-Machine Seamlessness: handoff sentinel boot-wiring + operator trigger (C2b/C3)

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3e (converged, approved)

Bolts the outgoing planned-handoff conductor (HandoffSentinel, built + unit-tested as a
factory in the prior increment) into the live server boot, and exposes the explicit
operator/test trigger. The protocol pieces (lease, live-tail, ack/yield/begin wire, receiver)
were already wired in earlier increments; this closes the outgoing-side gap so a planned
handoff can actually be initiated and run end-to-end. C2b (boot wiring + trigger route) and C3
(two-server e2e) land together because the trigger route touches `src/server/`, which the
e2e-pairing gate requires to ship with a `tests/e2e/*.test.ts`.

## What changed
- `src/core/handoffSentinelBootWiring.ts` — NEW. `createHandoffSentinelBootWiring(deps)` binds
  the sentinel to the live components (Telegram adapter, coordinator, LiveTailSource, wire
  transport) and owns the active-topic selection (`pickActiveTopic` — most-recently-active
  topic; getTopicHistory is chronological so the last entry is newest). Extracted from server.ts
  so the boot glue is a tested unit, mirroring `handoffReceiverWiring`.
- `src/server/handoffInitiateRoutes.ts` — NEW. `POST /handoff/initiate` (bearer-authed, mounted
  after the global auth middleware) → runs the sentinel to a terminal outcome; `failed`→500,
  `handed-off`/`aborted-stay-awake`→200, both carry `{outcome,inProgress}`. `GET /handoff/status`
  exposes `inProgress`. Unwired (solo / multi-machine off) → honest 503, never a silent ok.
- `src/server/AgentServer.ts` — added `onHandoffInitiate?` + `handoffInProgress?` options;
  imports + mounts `createHandoffInitiateRoutes` after the usher routes.
- `src/commands/server.ts` — inside the live-tail block (where `liveTailSource` is in scope,
  additionally gated on `handoffWireTransport`), constructs the boot wiring and exposes
  `handoffInitiate` + `handoffSentinelInProgress` to the AgentServer constructor.

## Over-block / under-block
- The lease is NEVER yielded unless the incoming's echo verifies (HandoffSentinel.ackMatches)
  AND validation passes — unchanged from the sentinel's own guarantee. The two-server e2e proves
  it over real HTTP: a caught-up standby hands off (B acquires, A demotes); a stale standby
  (divergent history → hash mismatch) makes A abort and stay awake with ZERO yield and B never
  acquiring. No two-holders window.
- The trigger is explicit-only. There is deliberately no sleep/wake auto-trigger:
  SleepWakeDetector emits only a `wake` event (verified), so there is no pre-sleep hook for v1.
  An automatic trigger is a tracked follow-on, NOT silently half-built here.
- Unwired → 503 (honest), proven by the e2e against a server with no `onHandoffInitiate`.

## Signal vs authority
- The route only pulls the trigger and surfaces the outcome. The DECISION to yield lives in
  HandoffSentinel; the lease CAS authority is the incoming coordinator's, fired solely by the
  explicit yield. The boot wiring supplies ops; it holds no authority of its own.

## Interactions
- Reuses the exact factories server.ts already boots (`createHandoffSentinelWiring`,
  `hashTopicHistory`) so outgoing-flush and incoming-echo hash identical bytes.
- `handoffInProgress` / `HandoffSentinel.inProgress` race guard: there is currently NO
  `holdsLease`-style gate in the scheduler or reaper to wire it into, so it is exposed
  (AgentServer option + `GET /handoff/status`) for future consumers rather than threaded into a
  nonexistent gate — wiring into a gate that doesn't exist would be scope creep. <!-- tracked: topic-13481 -->
- The trigger route is bearer-authed via the existing global `authMiddleware`; no new auth
  surface. The machine-to-machine begin/ack/yield routes (signed) are unchanged.

## Rollback cost
- Low. Two new standalone modules + two AgentServer options + one boot block. Reverting the
  boot block + the route mount fully disables the trigger; the protocol primitives (already on
  main from #419 + earlier wire increments) are untouched. No migration, no persisted state, no
  schema. The route 503s by construction when the option is absent, so a partial revert
  degrades safely.

## Tests
- `tests/unit/handoff-sentinel-boot-wiring.test.ts` (6) — wiring-integrity: non-null sentinel;
  full happy `initiate()` delegates pushTick→sendBegin→awaitAck→sendYield→demote in order (not a
  no-op); abort-on-echo-mismatch never yields/demotes; `pickActiveTopic` on all three branches.
- `tests/e2e/planned-handoff-e2e.test.ts` (4) — two real booted AgentServers with real peer
  resolvers: caught-up handoff (handed-off + B acquires with A's id + A demotes), stale-standby
  abort (no yield, A keeps lease), route alive (200 outcome), route 503 when unwired.
