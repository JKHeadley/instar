# Side effects — Track E part 2: SessionRouter dispatch engine + deliverMessage (§L4)

## What this adds
The L4 inbound-message dispatch engine, shipped DARK (constructed/activated only when `multiMachine.sessionPool.enabled` — boot wiring + the live-ingress interception land in Track E part 3 / Track H's staged rollout). No runtime behavior change for any deployed agent.

- `src/core/SessionRouter.ts` — `route(InboundMessage): Promise<RouteOutcome>`. Resolves session ownership and dispatches per §L4:
  - owned+alive+self → handle locally (no MeshRpc hop);
  - owned+alive+remote → forward via `deliverMessage` over MeshRpc (idempotent on `messageId`; the router treats the platform offset as advanceable ONLY after the owner's `queued`/`duplicate` ACK — `RouteOutcome.acked`);
  - owner dead / retries exhausted → owner-dead re-placement (mark suspect → re-place → claim);
  - transient (placing/transferring) → queue (ownership-contention);
  - unowned → `PlacementExecutor.decide()` → SYNCHRONOUS CAS-claim → spawn on the winner (CAS-loss → re-read → forward to confirmed owner / queue).
  - Per-session ordering: strictly in-order, at-most-one-in-flight (a per-session promise chain); different sessions dispatch concurrently. All I/O is injected (deterministic, unit-testable); the `deliverMessage` dep owns its own per-attempt timeout (throws on timeout) and the router owns the retry/backoff/fallback loop.
- `src/core/MeshRpc.ts` — added the `deliverMessage` command to the `MeshCommand` union (`{ session, messageId, payload, ownershipEpoch }`) and its RBAC (router-only, alongside place/transfer). This is the §L4 owner-forward command carried inside the §L0 signed, recipient-bound, replay-protected envelope.

## Risk / blast radius
None at runtime — `SessionRouter` is not yet imported by any boot path, and the new `deliverMessage` command type is inert until a handler is registered (part 3). The MeshRpc union/RBAC addition is additive; all 27 existing mesh tests still pass.

## Tests
- `tests/unit/SessionRouter.test.ts` — 15 tests: every dispatch branch (local, remote-forward, duplicate ACK, stale-ownership re-resolve, retry-then-owner-dead, owner-dead, transient-queue, unowned place→CAS won/self/blocked/queued, CAS-lost→forward/queue) + per-session in-order/one-in-flight serialization + cross-session concurrency.
- `tests/integration/session-router-dispatch.test.ts` — 3 tests over the REAL MeshRpc transport (signed envelopes, POST /mesh/rpc) + a REAL SessionOwnershipRegistry: deliverMessage owner-forward with offset-advance-only-after-ACK, idempotent redelivery (duplicate ACK, not re-processed), and two-router concurrent CAS → exactly-one-owner.

## Follow-ups (tracked in this same Track E / Track H)
Part 3: register the `deliverMessage` receive handler (owner-side MessageProcessingLedger dedupe) on the boot mesh dispatcher, construct SessionRouter behind the dark flag, expose on RouteContext, add the Tier-3 "router alive when enabled" E2E + agent-awareness (nickname-transfer) blurb. Live-ingress interception ("consult placement instead of always spawning locally") is gated by Track H's StageAdvancer — the designed dark-ship rollout boundary, not a deferral.
