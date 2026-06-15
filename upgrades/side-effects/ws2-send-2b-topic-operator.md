# Side-Effects Review — WS2-SEND-2b: topicOperator send-side replication

**Version / slug:** `ws2-send-2b-topic-operator`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (additive, dark-gated, put-only replication wiring; no block/allow/lifecycle authority — see §4. NOTE: touches AgentServer options + constructor, but only to attach an emitter to an existing store; no new decision surface.)

## Summary of the change

Wires the `topicOperator` store into the WS2 send-side — the first WS2-SEND-2b store, which (unlike the seamed managers) has its CANONICAL writer inside the AgentServer (`this.topicOperatorStore`, bound only from an authenticated sender uid). So the emitter is **plumbed into AgentServer** rather than attached to a server.ts var: a new optional `topicOperatorReplicationEmitter` AgentServer option carries the adapter (built in server.ts where the emitter + envelope helpers live), and the constructor attaches it to `this.topicOperatorStore` right after creation. `src/core/ws2SendWiring.ts` moves `topicOperator` PENDING→WIRED. New e2e round-trip. **PUT-ONLY by construction** — a topic rebinds, never unbinds, so a later bind supersedes the earlier operator by HLC on the receive side (no tombstone, no emitDelete).

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.topicOperator.enabled`) — **pass-through** — pre-existing; `topicOperator` becomes a registered emit target. Default false ⇒ no-op.
- `TopicOperatorStore.setOperator` emit funnel — **pass-through** — the store already fires emitPut on every authenticated bind; this attaches a real emitter (was no-op).
- `AgentServer` options (`topicOperatorReplicationEmitter`) — **add** — a new optional dependency-injection seam; absent while dark ⇒ no attach.
- `ws2SendWiring` ratchet — **modify** — `topicOperator` reclassified PENDING→WIRED.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The emitter never rejects a bind; a null recordKey / null projection is a counted no-op and the local authoritative bind always succeeds.

## 2. Under-block

Not applicable (no block surface). Put-only is the COMPLETE behavior, not a gap: there is no unbind/delete path by construction (a topic is rebound, never erased), so the receive side resolving the latest bind by HLC is correct and total. The buildTopicOperatorTombstoneData helper exists but no store event fires it — intentional.

## 3. Level-of-abstraction fit

Correct layer. The emit adapter lives in server.ts (with the emitter + helpers); the attach happens in AgentServer (the only place the canonical store exists). This is the AgentServer-plumbing the spec's WS2-SEND-2b prescribes — NOT a naive manager-var attach (which would miss the authoritative instance).

## 4. Signal vs authority compliance

Compliant. No blocking authority added. The emitter is additive/best-effort: a builder/journal failure is swallowed + counted, never propagated, so an authenticated bind can never fail because replication did. Per `docs/signal-vs-authority.md`, a replicator with no gate authority. **Know Your Principal (load-bearing):** a replicated topic-operator record is NEVER authoritative for "who is my verified operator?" — only the LOCAL bind from an authenticated sender establishes/overrides the operator; the crossed record is advisory, quoted untrusted data.

## 5. Interactions

- Shares server.ts's single `replicatedRecordEmitter` + the existing `topicOperatorUnionReader`. No double-fire (rides the single `setOperator` funnel). Distinct store key/kind from the other stores.
- The AgentServer attach is idempotent and gated on both the store existing AND the emitter option present — a store-init failure or dark gate both degrade to no-op.

## 6. External surfaces

Dark by default (`multiMachine.stateSync.topicOperator`). Off ⇒ byte-identical single-machine behavior. On (opt-in, multi-machine): only the disclosure-minimized projection (keyed on sha256(topicId + ":" + verified-uid)) crosses — never a content name; it can NEVER establish or override the local verified operator (advisory only). Same at-rest honesty as the other PII stores (transit encrypted; at-rest plaintext per machine).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated (put-only).** Path: `TopicOperatorStore.setOperator` (in AgentServer) → `ReplicatedRecordEmitter.emit` → `CoherenceJournal.emitReplicatedRecord` → peer serve/apply → `ReplicatedPeerStreamReader`. Identity = sha256(topicId + ":" + verified-uid). A rebind emits a fresh record; the receive side keeps the latest by HLC (no tombstone). No user-facing notice; the binding does NOT move on topic transfer (it is re-established locally from authenticated inbound on the new machine — by design).

## 8. Rollback cost

Trivial. Dark by default; affects only agents that enable `stateSync.topicOperator`. Back-out = revert the change or set the flag false (instant, no migration). The AgentServer option is additive/optional. Receive-side + envelope schema already shipped.
