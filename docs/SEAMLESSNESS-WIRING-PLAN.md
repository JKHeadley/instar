# Cross-Machine Seamlessness — Wiring Plan (crash-durable)

> Working roadmap for the FINAL integration stretch. Branch:
> `echo/cross-machine-seamlessness-spec` (worktree `.worktrees/seamlessness-spec`).
> Spec: `docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md` (converged + approved).
> If you are a recovered session: READ THIS FIRST, then `git log --oneline JKHeadley/main..HEAD`.

## Context
- PR #419 already merged the engine PARTS to main (G1 lease, G3a ledger, live-tail
  buffer/redaction, adapter contract). That same branch was REUSED for the wire-layer
  follow-on, so it is now N commits ahead of main again and needs a **NEW PR** to land.
- All component classes exist and are unit-tested. The remaining work is INTEGRATION:
  bolting them into the live server startup + message loop, then the live 2-machine test.

## Component status
- WIRED in server.ts: FencedLease/LeaseCoordinator/GitLeaseStore/HttpLeaseTransport (G1),
  RegistrySyncDebouncer+wireRegistrySync (G2), live-tail RECEIVER (G3b/c standby side),
  HttpLiveTailTransport (sender constructed but NOT driven).
- NOT yet instantiated/wired: LiveTailSource (holder flush producer), HandoffWireTransport,
  HandoffReceiver, HandoffSentinel. Handoff ack/yield routes added to machineRoutes.ts but
  UNCOMMITTED + callbacks not supplied at the mount point (AgentServer.ts:338).

## Increments (commit + push each; trace+side-effects per src/ commit via /instar-dev)
- [x] **A** — ack/yield route HTTP surface, NOW LIVE: machineRoutes.ts routes + AgentServer
      `handoffWireTransport?` option + server.ts instantiation (gated lease block, 1:1 peer
      resolver) + integration tests (20/20) + e2e feature-is-alive proof (12/12). The routes
      are reachable+authenticated+delivering through the real booted server. recordAck/
      recordYield are safe no-ops until the orchestration (C) registers a handler.
- [x] **B** — holder-side LiveTailSource: ALREADY DONE (committed be65cb1ce, wired at
      server.ts:8146 — holder pushes the tail every liveTailPushRateMs when peers present).
- [ ] **C** — handoff orchestration (CONCRETE DESIGN — execute this exactly):
      The protocol gap the spec left open: the **begin** signal (outgoing→incoming). Design:
      add `POST /api/handoff/begin` carrying the outgoing's `FlushManifest`
      `{ tailSeq, ingressPosition, threadHistoryHash }`. Symmetric with ack/yield.
      Wire flow (planned handoff, laptop=outgoing/awake → mini=incoming/standby):
      1. Trigger: expose `initiate()` via an authenticated LOCAL route `POST /handoff/initiate`
         (operator/test "hand off now"). NOT auto on sleep/wake (that's a later design).
      2. Outgoing `HandoffSentinel.ops`:
         - `flush()`: pushTick the LiveTailSource (so standby's buffer is current); capture
           `tailSeq` = the live-tail wire seq just sent; `ingressPosition` =
           `telegram.getIngressPosition()`; `threadHistoryHash` = sha256 of
           `telegram.getTopicHistory(activeTopic,500)` formatted same as LiveTailSource.
           POST the manifest to peer `/api/handoff/begin`. Return the manifest.
         - `awaitAck(ms)` → `handoffWireTransport.awaitAck(ms)`.
         - `validate(ack,manifest)` → Tier-1: deterministic readiness (ack.tailSeq===manifest
           .tailSeq && hashes match — sentinel already does ackMatches; validate adds a
           sharedIntelligence Haiku check IF available, else deterministic true). Timeout=abort.
         - `sendYield()` → `handoffWireTransport.sendYield()`.
         - `demoteSelf()` → `coordinator.demoteToStandby('planned handoff: yielded to peer')`.
      3. Incoming `HandoffReceiver.ops` (constructed on EVERY mesh machine; acts when it's standby):
         - begin route stores the received manifest, calls `receiver.onBeginHandoff()`.
         - `buildAck()`: echo `manifest.tailSeq` + `manifest.ingressPosition`; compute OWN
           `threadHistoryHash` from its loaded history (matches iff caught up via live-tail).
         - `sendAck(ack)` → `handoffWireTransport.sendAck(ack)`.
         - `acquireOnYield()` → `coordinator.acquireLeaseOnConsent(peerMachineId)`.
         - register `handoffWireTransport.onYield(() => receiver.onYield())`.
      4. Race guard: scheduler/reaper check `handoffSentinel.inProgress` (already on the class) —
         wire a getter into the gates that already check holdsLease.
      5. AgentServer: add `onHandoffBegin?` option (→ store manifest + receiver.onBeginHandoff).
         machineRoutes: add `/api/handoff/begin` (authMiddleware, validates manifest shape).
      6. Wiring-integrity test (spec §10 MANDATES): assert HandoffSentinel + HandoffReceiver
         constructed in startup (not null/dead) + e2e planned-handoff over two booted servers.
      Sub-increments (commit+push each):
      - [x] C1-begin: POST /api/handoff/begin route + AgentServer onHandoffBegin? option +
            integration/e2e tests. (commit eb2277b3d)
      - [x] C-receiver: src/core/handoffReceiverWiring.ts factory (begin→buildAck+sendAck;
            yield→acquireLeaseOnConsent) + exported hashTopicHistory + server.ts wiring +
            unit test. (commit 79e9bf23f)
      - [ ] C2: OUTGOING HandoffSentinel construction + ops + initiate trigger + race guard:
            * Extract a `createHandoffSentinelWiring({ pushTick, getIngressPosition,
              getTopicHistory, activeTopic, postBegin, awaitAck, sendYield, demoteSelf,
              validate })` factory (mirror C-receiver) → returns { sentinel, initiate }.
            * flush(): await pushTick() (drive LiveTailSource so standby is current); build
              manifest { tailSeq, ingressPosition=getIngressPosition(), threadHistoryHash=
              hashTopicHistory(getTopicHistory, activeTopic), topic }; await postBegin(manifest)
              (POST /api/handoff/begin to peer via a new HandoffWireTransport.sendBegin OR a
              thin fetch); return manifest.
            * tailSeq: use the live-tail send transport's last wire seq. REFINEMENT (tracked,
              topic-13481): echo the STANDBY's buffer-applied seq instead, needs
              LiveTailBuffer.getAppliedSeq(topic) + thread it to the receiver. Hash is the
              substantive caught-up check; tailSeq echo is secondary — acceptable for v1.
            * validate(): deterministic for v1 (ackMatches already in sentinel) — a Haiku
              tier is the spec's Tier-1 upgrade (tracked). Timeout-as-abort already enforced.
            * sendYield → handoffWireTransport.sendYield ; demoteSelf → coordinator.demoteToStandby.
            * initiate trigger: authenticated LOCAL route POST /handoff/initiate (operator/
              test "hand off now"). server.ts wires it to sentinel.initiate().
            * race guard: expose sentinel.inProgress; wire into scheduler/reaper gates that
              already check holdsLease (so they pause mid-handoff).
            * Add HandoffWireTransport.sendBegin(manifest) (POST /api/handoff/begin) — symmetric
              with sendAck/sendYield. Unit-test it.
      - [ ] C3: two-server e2e planned handoff (B catches up, acks, A verifies, yields, B
            acquires) + wiring-integrity (sentinel constructed in startup).
      NOTE: LiveTailBuffer may need a public `getAppliedSeq(topic)` accessor (the tailSeq
      refinement above).
- [ ] **D** — verify G3a message-ledger gates the REAL Telegram ingress (exactly-once) +
      CONTINUATION resume on the receiving machine (no re-greet).
- [ ] **E** — integration + e2e + fault-injection tests for the wired path.
- [ ] **F** — build green + full battery + push + open NEW PR + CI green + merge to main.
- [ ] **G** — real two-machine over-Telegram test-as-self (laptop awake + mini standby):
      drive a live Telegram convo through a planned handoff AND a hard failover; verify from
      the user's chair: no lost msg, no dup reply, no re-greet, thread continuity.
- [ ] **H** — final report to Justin (topic 13481) + memory update + upgrade note.

## Hard rules in play
- instar-dev gate: every src/ commit needs trace (`skills/instar-dev/scripts/write-trace.mjs`)
  + side-effects artifact + `--spec docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md`.
- Bob (port 4040) and Justin's real agents MUST stay untouched in the live test. Use a
  throwaway test mesh on non-default ports; clean up after.
- No context-death self-stops. Durable artifacts on disk = keep going.
