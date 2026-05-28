# Side-Effects Review — Cross-Machine Seamlessness: handoff ack/yield wire

**Spec:** docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §8 G3d/G3e (converged, approved)

Third piece of the wire-transport increment. The point-to-point ack/yield channel
the two machines use to negotiate a verified, lease-safe planned handoff.

## What changed
- `src/core/HandoffWireTransport.ts` — NEW. Symmetric transport, used per-role:
  - OUTGOING: `awaitAck(timeoutMs)` (resolves when the incoming POSTs its ack via
    recordAck; null on timeout, timer unref'd), `sendYield()` (POST the explicit
    yield to the incoming).
  - INCOMING: `sendAck(ack)` (POST the "caught up" echo to the outgoing),
    `onYield(cb)`/`recordYield()` (the yield route triggers the incoming's lease CAS).
  All POSTs ride the authenticated channel (signRequest). Injected fetch/clock.
- `src/server/machineRoutes.ts` — NEW routes `POST /api/handoff/ack` and
  `POST /api/handoff/yield` (both authMiddleware). `/ack` validates the echo shape
  (tailSeq + ingressPosition + threadHistoryHash) and delivers it via `onHandoffAck`;
  `/yield` delivers via `onHandoffYield`. Both return 503 when the callback is
  absent (honest — consistent with the live-tail receiver), never a silent ok.
- `src/server/AgentServer.ts` — NEW `handoffWireTransport?` option
  (`{ recordAck, recordYield }`, mirrors `leaseTransport`). When present, the mount
  wires `onHandoffAck → transport.recordAck` and `onHandoffYield → transport.recordYield`;
  absent → the routes stay 503. This is what flips the routes from dangling handlers
  to LIVE on a mesh machine.
- `src/commands/server.ts` — instantiate ONE `HandoffWireTransport` in the fenced-lease
  block (gated on `coordinator.enabled && isGitRepo && gitBackupEnabled`), with a 1:1
  `peer()` resolver (first reachable non-self machine; null for a solo agent → sends are
  reachable no-ops) and a monotonic `nextSequence`. Passed straight into AgentServer
  options. A single-machine mesh behaves exactly as before (no peer → no sends).

## Over-block / under-block
- The yield is the SOLE trigger for the incoming's lease CAS (the design closes the
  two-holders-same-epoch window). A dropped/missing yield → the incoming simply never
  acquires → the outgoing stays awake (safe under-action, no double-leader).
- `awaitAck` supersedes any stale pending wait and always resolves (ack or null) — it
  cannot wedge the HandoffSentinel.
- recordAck with no pending wait, recordYield with no handler, and no-peer sends are all
  safe no-ops / false returns (tested).

## Signal vs authority
- The transport carries no authority — it moves the ack and the yield. The DECISION to
  yield (verified ack + passing validation) lives in HandoffSentinel (§8 G3e), which is
  the next integrating step that constructs these ops; the lease CAS itself is the
  authority. This transport only delivers the negotiated signals.

## Interactions
- Reuses signRequest/machineAuthMiddleware (the same authenticated machine channel as
  /api/lease and /api/live-tail). 1:1 with the single peer (resolved by the caller).
- Consumes `HandoffAck`/`IngressPosition` from HandoffSentinel/types (already shipped).
- **Done here:** the transport is now instantiated in server.ts and bolted into the
  live route mount via the AgentServer option — both routes are LIVE on a mesh machine
  (e2e-proven through the real booted server). The transport carries the ack/yield; with
  no handler registered yet, recordAck-with-no-pending and recordYield-with-no-handler are
  safe no-ops (logged, 200 at the route).
- **Next piece (next increment):** construct the OUTGOING HandoffSentinel (drives flush →
  awaitAck-on-this-transport → verify → sendYield → demoteSelf) and the INCOMING
  HandoffReceiver (buildAck from buffer+ingress+threadHash; `onYield` registers the
  receiver's lease-CAS via `recordYield`), plus the `inProgress` race guard so the
  reaper/scheduler don't act mid-handoff. <!-- tracked: topic-13481 -->

## Rollback cost
- Low. Two additive routes + one new standalone class + one optional AgentServer option +
  one gated server.ts instantiation. Reverting removes them with no behavior change to a
  solo agent (the transport is a reachable no-op with no peer) and only disables the
  not-yet-orchestrated ack/yield channel on a mesh.

## Tests
- `tests/unit/HandoffWireTransport.test.ts` (7): awaitAck resolves on recordAck, awaitAck
  times out → null, sendYield/sendAck POST to the right endpoints with signed headers,
  onYield handler fires, no-peer → false, recordAck-with-no-pending safe no-op. tsc clean.
- `tests/integration/machine-routes.test.ts` (+6, route surface): a valid signed ack is
  delivered to `onHandoffAck` with the authenticated machine id; a malformed echo (missing
  ingressPosition/threadHistoryHash) → 400 and the callback never fires; an unauthenticated
  ack/yield → 401; a valid signed yield is delivered to `onHandoffYield` with the machine id;
  and — the honest-503 contract — a route set built WITHOUT the callbacks returns 503 for
  both ack and yield (never a silent ok). Full machine-routes suite green (20/20), tsc clean.
- `tests/e2e/multi-machine-http.test.ts` (+3, feature-is-alive): two AgentServers boot for
  real; a signed ack POSTed from machine B over HTTP resolves machine A's pending
  `awaitAck` with the echoed tailSeq/hash; a signed yield fires A's registered yield
  handler; an unsigned ack → 401 and a malformed echo → 400. This is the Tier-3 proof that
  the routes are ALIVE through the production AgentServer mount, not silently 503. (12/12)
