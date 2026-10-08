# Side-Effects Review — A2A cross-machine route

**Version / slug:** `a2a-cross-machine-route`
**Date:** `2026-10-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-cross-machine-route.md (v7, converged in 5 iterations; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Evolution action ACT-052.

## Summary of the change

A relay standby (a machine with `multiMachine.telegramPolling: false`) has no relay client, so every send it makes answers 503. It now forwards the send once, over the existing signed mesh RPC, to the machine of the same agent that holds the relay connection; that machine runs the complete ordinary relay-send route and owns the records; a reply on a topic-bound thread is typed into the topic's live session on whichever machine has it.

- `src/threadline/relayForward.ts` (new, pure logic, so the tests run the code the server runs): the boot secret and its constant-time check; the gate; `RelayHolderFinder` (parallel `/threadline/health` probes, 60 s cache); `RelayForwarder` and `classifyForwardResult`; `handleRelayForwardCommand` (the holder: a loopback POST); `buildForwardAnswer`; `handleTopicReplyInjectCommand` (the receiver); `askTopicOwner`; counters and the log line.
- `src/core/MeshRpc.ts`: two verbs, `a2a-relay-forward` and `a2a-topic-reply-inject`, in the registered-peer RBAC class.
- `src/server/routes.ts` (`POST /threadline/relay-send`): the forward at the 503 point; the forwarded-request behaviour under the secret; counters on the authed `/health`.
- `src/threadline/TopicLinkageHandler.ts`: the sender-check fix; `machineOrigin` on capture; the remote ask before the topic-active test; the surface/commitment tail factored into `finishRouted` (unchanged logic).
- `src/threadline/ThreadlineRouter.ts` passes `machineOrigin`; `src/threadline/ThreadlineBootstrap.ts` returns `relaySuppressedByStandby`.
- `src/commands/server.ts`: one shared context (secret, standby fact, forwarder, counters), both mesh handlers, the sending legs where the mesh client exists, and the handler's new dependencies. `src/server/AgentServer.ts` passes the context through.
- `src/threadline/ThreadlineMCPServer.ts`, `src/threadline/mcp-http-client.ts`: `forwardedTo`, `replyArrivesIn`.
- `src/core/types.ts`, `src/core/devGatedFeatures.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`: config type, dev gate, the "A2A relay forward" awareness section and its migration.

## Decision-point inventory

- When a forward is tried (`routes.ts`, the 503 point) — **add** — invariant: relay client absent AND the boot-time standby fact AND not a credential share AND not itself a forwarded request AND the gate on AND a forwarder wired.
- Which checks the holder runs (`routes.ts`, under the boot secret) — **add** — invariant: a skip needs an absent field or the secret.
- What the caller is told and what is settled (`buildForwardAnswer`) — **add** — invariant: the holder's answer is transcribed, never upgraded.
- Where a topic-bound reply is delivered (`TopicLinkageHandler.routeViaTopicOwner`) — **add** — invariant: the receiver's own live session, else the existing Telegram post.
- Topic-linkage sender check — **modify** — also accepts a sender equal to the thread entry's resolved fingerprint.

---

## 1. Over-block

Nothing that is delivered today is refused. With the gate off, no forwarder wired, or on a single machine, the route and the handler take exactly the previous paths. A standby's send that finds no holder, or whose forward did not execute, answers the same 503 body as before. On the holder, a request without the secret is an ordinary send: `messageId`, `resend`, `resolvedFp` and `forwardedFromMachine` in its body are inert.

One narrowing that is intended: a forwarded request never uses the holder's local-delivery branches, so a target that runs on the holder's machine is reached through the relay. Without that, a holder 503 would not prove the forward sent nothing.

## 2. Under-block

- A displaced or disconnected machine (a relay client exists but is not connected) keeps the 503 on purpose: two owners trade the connection and a thread recorded on the holder of the moment would be orphaned.
- A send with no topic gets its reply on the holder, not in the sending session (same as a holder-originated parentless thread today).
- `waitForReply` is not honoured across machines; the answer is `reply: null` at once, and the MCP rendering says where the reply will arrive.
- Negotiator single-voice is not enforced across machines: the gate runs on the standby against the speaking session and is skipped on the holder. The gate is dry-run today.
- A second reply inside the per-thread minute while the other machine is unreachable is neither injected nor posted; it stays in the holder's hub with its commitment open (tracked as ACT-070).
- An inject that timed out but landed is also posted to the topic: one visible duplicate note, never a second processing.

## 3. Level-of-abstraction fit

The forward sits at the one place the route already decides "no relay here", and reuses the route itself on the holder by a loopback call instead of a second implementation of a thousand lines of closure state (the lift is ACT-068). The reply ask sits in `TopicLinkageHandler`, the existing owner of "which session gets a topic-bound reply", ahead of the topic-active test; it reuses the existing failure-visible surface, rate limits and commitment lifecycle through `finishRouted`. The mesh verbs ride the existing dispatcher (signature, recipient binding, nonce guard, registered-peer RBAC). The decision logic is a pure module.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on message content.

The only refusals are structural and closed: a standby handler refuses a forward (the loop stop), a handler refuses with the gate off, and the mesh dispatcher refuses an unregistered or replayed envelope. The peer health answer (`connected` + own fingerprint) is a hint for where to send; the holder's own 503 guard is the authority, and a wrong hint is today's 503. `machineOrigin` and the ownership record are hints for whom to ask; the receiver's own live session is the authority for the inject. No content is judged anywhere.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. All four decision points are closed enumerations (spec "Decision points touched": invariant). The ask order is a fixed two-step list with a stated stop rule (no second ask unless the first machine itself reported that it attempted nothing).

## 5. Interactions

- **Shadowing.** The forward runs only after the sender's own warm-reply rule, authenticated-inbound rule, reply claim, negotiator gate, credential refusal and local-delivery attempt, so none of them is shadowed. The remote ask runs after the sender check and before the topic-active test; a live local session wins before any ask.
- **Double-fire.** One attempt, no retry, no queue. The forwarded request keeps the standby's message id, so a receiver's inbound-id ledger sees ONE id on every route; `resend` carries the standby's local-attempt uncertainty (a2a-backup-routes §1). The Telegram surface is fired only by `finishRouted`, once per reply, under the existing per-thread and per-topic limits.
- **Races.** Only the per-thread spawn lock is held during the asks (at most 12 seconds); a second reply on that thread in the window is refused "Spawn already in progress", as today. The holder cache is dropped on any forward failure. `machineOrigin` is overwritten only by a forwarded capture, so a topic that moved to a second standby asks the right machine first; a stale value is harmless because a live local session wins.
- **Reply claim / reap recovery.** The standby writes one settlement line (`inReplyTo`, the request's own thread, the holder's outcome) so reap recovery does not re-drive an answered inbound; a 502, a holder 4xx and a 503 settle nothing and the existing finish handler releases the claim.
- **Feedback loops.** A forwarded request never forwards again (the trigger is skipped under the secret; a standby handler refuses).
- **Refactor risk.** The surface/commitment tail of `tryRouteReplyToTopic` moved into `finishRouted` unchanged; the existing `TopicLinkageHandler.test.ts` (24 tests) passes unmodified.

## 6. External surfaces

- **Other agents.** A peer receives one ordinary relay message from the agent's fingerprint. Nothing about it says it was forwarded.
- **My other machines.** Two new mesh verbs. An older peer answers `claim-unauthorized`: for a forward that is today's 503; for an inject it is the Telegram post. One unauthenticated `GET /threadline/health` per peer per forward-holder lookup (cached 60 s, at most 8 peers, 2 seconds).
- **Message bodies** cross between my machines signed but not encrypted by the mesh; Tailscale and Cloudflare ropes encrypt in transit, a LAN rope is plain HTTP. Accepted for ordinary messages (spec "Threat model"). Credential sends are refused on the sender and never cross.
- **The boot secret** exists only in process memory, travels only in a header of a request to `127.0.0.1`, is compared with `timingSafeEqual` over SHA-256 digests, and appears in no log line, response, env var or config (asserted in unit and e2e tests).
- **Persistent state.** Nothing new: `machineOrigin` is an existing conversation field; the settlement line is an ordinary outbox entry.
- **Result fields.** Additive: `deliveryPath: 'forwarded'`, `forwardedTo`, `replyArrivesIn`, `reply: null`; counters under `threadline.relayForward` on the authed `/health`; `[a2a-forward]` server-log lines (message id, machine nickname, outcome label — no content).
- **Operator surface:** no operator-facing actions.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified on the holder.** A2A records (tracker row, thread leg, origin capture and commitment, outbox entry, bridge mirror) live on the relay holder for forwarded sends and its own sends alike, which is the posture today; replicating them is ACT-054. They are read from any machine through the existing pool reads (`GET /threadline/peers/health?scope=pool`, `GET /threadline/conversations?scope=mesh`). The standby stores nothing but one settlement line for a reply it made.

- **User-facing notices:** the only notice is the existing failure-visible Telegram post, made by the holder alone (one voice); an injected reply produces none.
- **Durable state on topic transfer:** the thread's `machineOrigin` may go stale when a topic moves; the handler then asks the machine the ownership record names, and failing that posts to the topic. Nothing strands silently.
- **URLs:** none generated.
- **Ownership-Gated Side Effects:** the only session-scoped side effect is the inject, authorised by the receiver from its own live session for that topic. A stale duplicate session is the duplicate-session reconciler's concern.

## 8. Rollback cost

`threadline.relayForward.enabled: false`, read live on every machine, restores today's 503 on a standby and today's topic linkage on the holder — no restart. After that, a reply to a thread that was already forwarded finds no local session on the holder, takes `topic-expired`, and spawns on the holder (the integration tier asserts this contrast case). A code revert is safe: nothing new is stored, the verbs are additive, and the result fields are additive. The sender-check fix is not gated; reverting it is a code change.

## Conclusion

The build follows spec v7. Every failure degrades to behaviour that exists today: the 503, a transcribed refusal, `unconfirmed`, or the visible Telegram post. Clear to ship dark (dev-gated).

## Evidence pointers

- `tests/unit/a2a-cross-machine-route.test.ts` (116) — the secret, the gate, both sides of every trigger condition, the holder cache, each answer class with its settlement and claim row, the holder handler (gate off, standby, bad payload, 503, refused loopback, timeout), the inject receiver (alive, not alive, never spawns), the ask, and the real route on a standby and on the holder (right, wrong and missing secret; a co-located target still over the relay; a forwarded request never forwarding again).
- `tests/unit/TopicLinkageHandler-remoteReply.test.ts` (43) — the name-addressed sender check, `machineOrigin` overwrite, the ask order and single budget, no second ask after a timeout, a throwing ownership read or ask still `routed`, "no `machineOrigin` and no record" asserting today's exact outcome, and a real ThreadlineRouter never spawning on any failure path.
- `tests/unit/PostUpdateMigrator-a2aRelayForward.test.ts` (4) — migration parity, template, dev gate, no config default.
- `tests/unit/threadline/ThreadlineMCPServer.test.ts`, `tests/unit/threadline-mcp-send-path.test.ts` — the MCP contract for the new result fields.
- `tests/integration/threadline/a2a-cross-machine-route.test.ts` (15) — two real servers of one agent identity, a real RelayServer, real Ed25519 mesh RPC, a third agent addressed by name: one copy arrives; all records on the holder; the reply injected into the standby's session; a replayed envelope refused; and nothing spawned on the holder with no ownership record, an unreachable machine, an older peer answering `claim-unauthorized`, a timeout, a rate-limited post and a failing Telegram post.
- `tests/e2e/threadline/a2a-cross-machine-route-alive.test.ts` (14) — two real AgentServers sharing one identity, one bootstrapped as a standby: both verbs alive on `/mesh/rpc`, gate on returns the holder's verdict (through the MCP client too), gate off is the 503, and server.ts wiring integrity.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Concur — no blocking findings. The reviewer read the spec and the working-tree diff without the author's conclusions and checked seven fail directions. Verified correct: the hijack guard is not weakened (the only writers of a thread's resolved fingerprint are the agent's own send paths); a handler throw is a reasonless 500 and classifies as `unconfirmed`, never a false 503; the relay-send route has exactly one 503, before any relay send, so a holder 503 proves nothing was sent; the wiring order holds (context and secret before the bootstrap, the dispatcher and the AgentServer; `forward` null answers 503 until the mesh client exists); there are two loop stops; the secret stays in memory; no unbounded await or stray rejection. Four nits were fixed before commit: (1) the MCP note for a forwarded `unconfirmed` send with `waitForReply` said "Sent" — it now says the delivery is unknown and appends to an existing note; (2) with the gate off the handler made one extra liveness probe — the plan is now computed first, so the gate-off path is call-for-call today's (asserted); (3) a holder 503 was counted as handled — it now counts as refused; (4) the settlement line's `to` is the fingerprint the holder reported. Two findings were kept as the spec has them and are recorded below.

## Reviewer findings kept as specified (recorded)

- **A stale `machineOrigin` with a DORMANT local session.** A thread forwarded once from a standby, whose topic then moved to the holder, and a reply arriving while the holder's session for it is dormant: the standby is asked, answers a definitive no, no other machine is named, and the reply is posted to the topic (`failure-visible`), where the previous code would have marked it `resume-pending` (quiet when low-salience). Spec §5 lists "no live session" under the Telegram post and argues only the live-session case as harmless. The result is one visible post, never a loss and never a spawn. Changing it needs a spec amendment, so it is left as written.
- **`replyArrivesIn` on a refused answer, and on a capture the holder declined.** The field is added to every transcribed answer (spec §4), including a 4xx/502 where no reply will come, and is derived from the standby's topic, as the holder's own `topicLinkageStamped` is. When the holder's first-write-wins rule declines the capture, the caller is told `topic-session` while the reply lands in the holder's hub.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The change adds no self-triggered controller: every forward and every ask is caused by one caller's send or one inbound reply, is attempted once, and is never retried, queued or re-driven.

## Deviations from the spec text (recorded)

- **A definitive not-injected is declared by the receiver.** The spec's receiver answers `{ injected: false, reason }`. The build adds a `definitive` boolean: `true` when the receiver attempted nothing (no session, session not alive, gate off, bad payload), `false` when the confirmed paste was attempted and not confirmed. Only `definitive: true` permits the second ask. Without it, a paste that was slow but landed could be followed by an inject on a third machine. The fail direction is the spec's own: toward the Telegram post.
- **The holder's verdict is a typed result.** The mesh dispatcher answers HTTP 200 for any handler return, so the handler returns `{ outcome: 'answered', status, body } | { outcome: 'refused', reason } | { outcome: 'unknown', reason }` and the sender classifies that. A holder loopback that timed out is `unknown`, which the sender reports as `unconfirmed` (never a 503, since the route may have sent).
- **The second ask needs at least one second of budget left.** With less, it is skipped and the reply is posted.
- **E2E tier.** `startServer` in `src/commands/server.ts` cannot be booted inside a test, so the e2e tier boots two real AgentServers with the real bootstrap, the real dispatcher and the real handlers, and asserts the server.ts wiring by source inspection (the repo's existing wiring-integrity pattern).
