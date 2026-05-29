# Side effects — Session Pool activation wiring (§L4 live-ingress, dark)

## What this adds (task A of the activation)
Wires the SessionRouter into the live boot + the inbound message-dispatch path, GATED so it is inert until the rollout stage advances past 'dark'.

- `src/commands/server.ts`:
  - Module-level refs `_sessionRouter` + `_sessionPoolStage()` (the idiomatic instar pattern — the inbound handler in `wireTelegramRouting` is defined above `startServer`, so the router constructed in startServer's mesh block is shared via a module ref, like `_orphanReaper`/`_topicResumeMap`).
  - **Construction** (mesh block, when a machine identity exists): `new SessionRouter({...})` wired to the real `MachinePoolRegistry` (machineRegistry), `SessionOwnershipRegistry` (resolveOwnership + casClaimOwnership), `PlacementExecutor`, and an outbound `MeshRpcClient` (deliverMessage/spawnOnMachine to peers via `lastKnownUrl`). `_sessionPoolStage()` reads the live `multiMachine.sessionPool.{enabled,stage}` (defaults 'dark').
  - **Interception** (inbound `onTopicMessage`, after target-session resolution): when `_sessionRouter && _sessionPoolStage() !== 'dark'`, consult `route()`; a `forwarded`/`duplicate` outcome short-circuits (the owner machine handles it); everything else falls through to the existing local dispatch. Wrapped in try/catch → falls back to local on any error.

## Risk / blast radius
**None in production.** The gate defaults to dark on three independent conditions: `_sessionRouter` is null without machine identity; `_sessionPoolStage()` returns 'dark' unless `enabled && stage` set (ConfigDefaults ships enabled:false/stage:dark); and the interception fails safe to local dispatch. So a single-machine, un-activated agent is byte-identical to today. The live-transfer behavior is gated by the staged rollout (StageAdvancer + E2E records).

## Tests
- `tests/unit/session-pool-activation-wiring.test.ts` — 4 wiring-integrity tests pinning the safety invariants: gated on non-dark stage (default-dark → inert), fail-safe try/catch → local, real-deps construction (registry/ownership/placement + MeshRpcClient), module-ref sharing. Guards against a regression that removes the gate (which would activate cross-machine routing unconditionally).
- SessionRouter behavior itself is covered by its 17 unit + 3 integration tests (#506).

## Remaining (the hardware operation — B/C/D)
Deploy to laptop + bring up the mini as machine #2; advance dark→shadow→live-transfer (each E2E-gated); test-as-self nickname-swap proof. The owner-side deliverMessage→local-spawn bridge (so a forwarded message actually spawns on the owner) is the final piece, validated on the 2-machine setup.

## Addendum — owner-side bridge (task A.2)
`createDeliverMessageHandler` now takes an `onAccepted` hook wired (in the mesh block) to `spawnSessionForTopic`: a FIRST-seen forwarded `deliverMessage` spawns/resumes the local session for the topic so the conversation continues on the OWNER machine — the receive-side of the §L4 handoff. Gated on `_sessionPoolStage() !== 'dark'` + `telegram` present; fire-and-forget (the durable receipt is ACKed before this runs); fails safe (logs, never throws into the dispatcher). Inert until live-transfer (a deliverMessage only arrives from a router peer). This makes the activation code-complete: outbound forward (router) + receive+ACK (handler) + owner-side resume (bridge). Remaining is purely the 2-machine hardware proof.
