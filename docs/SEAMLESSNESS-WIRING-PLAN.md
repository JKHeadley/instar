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
      - [x] C2a: HandoffWireTransport.sendBegin + createHandoffSentinelWiring factory + unit
            tests (5: happy hands-off; mismatch/no-ack/failed-validate/unreachable-peer all
            abort with zero yield/demote). (commit 50e4ca77c)
      - [x] C2b + C3 (landed together — POST /handoff/initiate touches src/server so the
            e2e-pairing gate forces the two-server e2e in the same commit):
            * src/core/handoffSentinelBootWiring.ts — extracted boot factory (active-topic
              picker + dep binding) so the glue is unit-tested, not inline. server.ts boot
              calls it inside the live-tail block (handoffWireTransport-gated); exposes
              initiate + sentinel.inProgress to outer scope.
            * src/server/handoffInitiateRoutes.ts — POST /handoff/initiate (bearer) returns
              {outcome,inProgress}; failed→500, handed-off/aborted→200; unwired→503. GET
              /handoff/status. AgentServer: onHandoffInitiate? + handoffInProgress? options,
              mounted after global auth.
            * server.ts: AgentServer gets onHandoffInitiate/handoffInProgress.
            * tests/unit/handoff-sentinel-boot-wiring.test.ts (6) — wiring-integrity:
              non-null sentinel, full happy initiate() delegates pushTick→sendBegin→awaitAck
              →sendYield→demote in order, abort-on-mismatch never yields/demotes,
              pickActiveTopic both sides.
            * tests/e2e/planned-handoff-e2e.test.ts (4) — TWO real servers, real peer
              resolvers: caught-up→handed-off+B acquires+A demotes; divergent history→
              aborted-stay-awake+no yield+A keeps lease (no-two-holders over the wire);
              route alive (200 outcome) + 503 unwired.
            * Race guard: HandoffSentinel.inProgress is exposed (AgentServer option +
              GET /handoff/status). There is NO existing holdsLease gate in scheduler/reaper
              to wire it into, so wiring it into a nonexistent gate would be scope creep;
              exposed for future consumers instead. <!-- tracked: topic-13481 -->
      - [ ] C2b-orig (superseded): bolt the sentinel into server.ts boot — CONFIRMED FINDINGS:
            * Insertion point: the LiveTailSource block at `src/commands/server.ts:8177`
              (`if (liveTailSendTransport && telegram && coordinator.enabled)`) — `liveTailSource`
              is in scope there; additionally guard on `handoffWireTransport`.
            * Config: `seamlessness.handoffAckTimeoutMs` (5000) + `seamlessness.minHandoffIntervalMs`
              (60000) exist on the assertSeamlessnessInvariants result.
            * ops bindings: pushTick→liveTailSource.pushTick; getIngressPosition→telegram
              .getIngressPosition; getTopicHistory→telegram.getTopicHistory; activeTopic→pick the
              telegram.getKnownTopicIds() topic with the latest last-message ts; postBegin→
              handoffWireTransport.sendBegin; awaitAck→handoffWireTransport.awaitAck; sendYield→
              handoffWireTransport.sendYield; demoteSelf→coordinator.demoteToStandby('planned handoff').
            * TRIGGER: SleepWakeDetector emits ONLY 'wake' (no pre-sleep signal — verified), so a
              sleep-trigger is NOT viable. Use an explicit authenticated LOCAL route
              `POST /handoff/initiate` (bearer auth, in src/server/routes.ts or a small AgentServer
              router) → calls sentinel.initiate(). This touches src/server → e2e-pairing gate fires,
              so pair a tests/e2e/*.test.ts (the two-server planned-handoff e2e = C3 satisfies it).
            * race guard: expose sentinel.inProgress; gate the scheduler/reaper checks that already
              read holdsLease so they pause mid-handoff.
      - [ ] (was C2) reference for the above:
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
      - [x] C3: two-server e2e planned handoff — landed WITH C2b (commit c2848d4c9):
            tests/e2e/planned-handoff-e2e.test.ts (4) proves caught-up→handed-off+acquire+demote,
            divergent→aborted-stay-awake+no-yield (no-two-holders over the wire), route alive/503.
      NOTE: LiveTailBuffer may need a public `getAppliedSeq(topic)` accessor (the tailSeq
      refinement above).
- [ ] **D** — wire the G3a MessageProcessingLedger into the LIVE message loop (exactly-once).
      ⚠ SAFETY-CRITICAL: this touches the single most important path (every user message). The
      spec's no-loss is a HARD guarantee (§8 G3a, lines 199-205): the ingress cursor advances
      ONLY on durable completion, and `reply_committed` is tied to the ACTUAL outbound reply —
      NOT the inject. A partial version that treats "injected" as "handled" would DROP a reply on
      a crash-after-inject-before-reply. So D must be COMPLETE, and test-as-self'd on a live agent
      BEFORE merge (this is inherently a "Justin's machines" step). Build in this order, each its
      own commit + trace + side-effects + tested:

      GROUNDED HOOK POINTS (verified 2026-05-27):
        * dedupeKey = Telegram `update_id` (spec line 92). Lifeline forward body (TelegramLifeline
          .forwardToServer, ~:1305) currently sends `messageId` (message_id) + NOT update_id —
          ADD `updateId` to the forward body (additive, backward-compat; server falls back to
          `telegram:${topicId}:${messageId}` if absent).
        * Lifeline poll loop advances the offset IMMEDIATELY (TelegramLifeline.poll, :902-905:
          `lastUpdateId = max(...); saveOffset()` right after processUpdate). The "cursor advances
          only on cursor_advanced" rule means this advance must be gated on the server confirming
          durable completion (forward response carries `{handled:true|deferred}`); the offset only
          advances on confirmed-handled. THIS is the riskiest change — get it wrong → ingress
          stalls or re-delivers forever. Needs a fault-injection test (crash before confirm →
          replay → ledger no-ops).
        * Server inject chokepoint = routes.ts `POST /internal/telegram-forward` (:8612), inject at
          :8832, spawn-branch at :8895. Gate: record(dedupeKey) → isActedOn? return {handled:true,
          duplicate:true} (DROP, no re-inject) : beginProcessing(leaseEpoch) → inject/spawn.
        * reply_committed: hook the OUTBOUND reply path (telegram-reply.sh → the send route) so
          commitReply(dedupeKey, computeReplyIdempotencyKey(dedupeKey, idx), epoch) fires when the
          agent's reply is actually sent — NOT at inject. The dedupeKey must flow from inbound →
          the reply (thread it through the injected context / a per-topic "current inbound" map),
          since telegram-reply.sh today doesn't know the update_id. cursor_advanced after the
          reply commits durably.
        * leaseEpoch source: coordinator's fenced lease epoch (GET /health multiMachine.syncStatus
          .leaseEpoch, or coordinator.getLeaseEpoch()). Pass into beginProcessing/commitReply.
        * cross-machine marker: applyRemoteReplyMarker propagated over BOTH tunnel + git (the lease
          medium). Lower priority — the lease already ensures only ONE machine forwards, so cross-
          machine double-handle is already prevented; this is belt-and-suspenders for the failover
          window. Can be a tracked follow-on AFTER the same-machine guarantee + offset coordination.

      KEY REALIZATION (de-risked): the lifeline offset loop does NOT need surgery. Exactly-once
      rides on the LEDGER, not the Telegram offset — the offset keeps advancing normally so
      polling never stalls; the ledger dedups redeliveries + (with replay) recovers crashes.

      DECOMPOSITION:
      - [x] D-dedup (no-DUPLICATE-reply half) — DONE, flag-gated default-off (commit c-below):
            ingressDedup.ts (decideIngress/commitInboundReply/dedupeKeyFor) + inbound gate at
            /internal/telegram-forward (after sentinel, before routing; drop→{deduped:true}) +
            outbound commit at /telegram/reply/:topicId (after sendToTopic; skips proxy) + ledger
            built in boot when seamlessness.exactlyOnceIngress + coordinator.getLeaseEpoch().
            dedupeKey = telegram:<topic>:<message_id> (v1; update_id tracked refinement). 14 tests
            (8 unit + 5 integration + 1 e2e). FAIL-OPEN throughout. Strict improvement, no
            regression (a crash after inject-before-reply loses the reply exactly as today).
      - [ ] D-noloss (no-LOSS-on-crash half): on boot, re-inject un-committed ledger entries
            (received/processing, from inputSnapshot) so a crash/restart replays the turn. The
            half that makes loss impossible. Fault-injection tests (§8 G3a/§10).
      - [ ] D-xmachine: applyRemoteReplyMarker propagation over tunnel+git (failover window).
            Lower priority — the lease already prevents cross-machine double-forward.
      - [ ] D-refine: update_id as dedupeKey (vs message_id); per-topic concurrent-inbound queue.
      - [ ] D3 (CONTINUATION resume): the receiving machine resumes via CONTINUATION (no re-greet)
            — verify the standby's live-tail'd history feeds the resume briefing. Mostly present;
            verification + wiring-integrity.
      - [ ] FLAG FLIP (needs test-as-self): enable exactlyOnceIngress on a live agent, drive real
            duplicates/redeliveries, confirm no false-drops, THEN default-on / merge.
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
