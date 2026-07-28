# Side-Effects Review — WS2-SEND-2b: topicOperator send-side replication

**Version / slug:** `ws2-send-2b-topicoperator`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Extends WS2 send-side emission to the `topicOperator` store (a PII kind; WS2-SEND-2b). Unlike the seamed memory stores, topicOperator's authoritative writer is the AgentServer's OWN `TopicOperatorStore` (constructed internally at `AgentServer.ts:1092`, bound from the authenticated sender via `setOperator`). server.ts has no canonical instance of its own, so the emitter is attached AFTER the AgentServer exists, in server.ts right after `_agentServerRef = server`, via `server.getTopicOperatorStore()?.setOperatorReplicationEmitter(...)`. `ws2SendWiring.ts` moves `topicOperator` PENDING→WIRED. The union reader + projection already shipped (WS2.6). New e2e round-trip.

**PUT-ONLY by construction** — a topic-operator binding is rebound, never erased (the manager has no emitDelete path; the receive side resolves the latest binding by HLC). Wiring put-only is the COMPLETE correct behavior, not a deferred gap.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.topicOperator.enabled`) — **pass-through** — pre-existing; `topicOperator` becomes a registered emit target. Default false ⇒ no-op.
- `TopicOperatorStore.setOperator` emit funnel — **pass-through** — already fires emitPut on a real bind/rebind; this attaches a real emitter.
- `ws2SendWiring` ratchet — **modify** — `topicOperator` reclassified PENDING→WIRED.

---

## 1. Over-block
No block/allow surface. The emitter never rejects a bind; null recordKey / null projection / over-cap is a counted no-op and the local bind always succeeds.

## 2. Under-block
Not applicable (no block surface). PUT-ONLY is the correct, complete design: a topic rebinds (a new put supersedes by HLC), never unbinds, so there is no emitDelete to wire. A `buildTopicOperatorTombstoneData` helper exists for symmetry but no manager event fires it — by construction, not omission.

## 3. Level-of-abstraction fit
Correct layer. The attach point is at the server-composition layer (where the AgentServer and its store exist), which is the only place the authoritative TopicOperatorStore is reachable. The projection lives in `TopicOperatorReplicatedStore` beside the receive-side schema.

## 4. Signal vs authority compliance
Compliant. No blocking authority. The emitter is additive/best-effort (the funnel swallows + counts faults; a bind can never fail because replication did). **Know Your Principal (REQ-M14):** only the platform-verified `uid` + lowercased display names are emitted — a content name can NEVER become an operator. A replicated topic-operator record is UNTRUSTED peer data and is NEVER the authoritative answer to "who is my verified operator of this topic?" — only the LOCAL bind from an authenticated sender is authoritative. The union read is advisory HIGH-tier. Per `docs/signal-vs-authority.md`.

## 5. Interactions
- Uses server.ts's single `replicatedRecordEmitter` (in scope at the attach point, constructed earlier). Distinct store key/kind from the other WS2 stores. No double-fire (rides the single setOperator funnel).
- Touches `server.ts` + `ws2SendWiring.ts` (the shared WS2-SEND files) → serialized on top of merged evolutionActions; no parallel WS2-SEND PRs.

## 6. External surfaces
Dark by default (`multiMachine.stateSync.topicOperator`). Off ⇒ byte-identical single-machine behavior. On (multi-machine, opt-in): crosses the sha-keyed (topicId + verified uid) projection — platform, uid, lowercased names, boundAt. Same at-rest honesty as relationships (transit encrypted; at-rest plaintext per machine). A received record is quoted `<replicated-untrusted-data>`, advisory only — never adopted as the operator.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Replicated (put-only).** Path: `TopicOperatorStore.setOperator → emit → CoherenceJournal.emitReplicatedRecord → peer serve/apply → ReplicatedPeerStreamReader → topicOperatorUnionReader`. Identity = sha(topicId + verified uid). A rebind re-emits the latest record (HLC-ordered); there is no delete (a topic never unbinds). Verified end-to-end by the new e2e (put round-trip + idempotent rebind replicates the latest boundAt).

## 8. Rollback cost
Trivial. Dark by default. Back-out = revert the server.ts + ws2SendWiring.ts change or set the flag false (instant, no migration). Receive-side + envelope schema already shipped, unaffected.
