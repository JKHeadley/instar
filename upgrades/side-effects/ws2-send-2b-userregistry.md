# Side-Effects Review — WS2-SEND-2b: userRegistry send-side replication

**Version / slug:** `ws2-send-2b-userregistry`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Extends WS2 send-side emission to the `userRegistry` store (the SECOND PII kind; WS2-SEND-2b). Unlike the seamed memory stores, `userRegistry` has NO single canonical UserManager — telegram (send-only mode + normal mode) and slack each construct their OWN long-lived `UserManager` against the same `users.json`. So a single shared attacher (`attachUserReplication`, defined in `src/commands/server.ts` right after the emitter is constructed) wires the journal-backed emitter to each long-lived instance at its construction site (`userManagerSendOnly`, `userManager`, `slackUserManager`). `ws2SendWiring.ts` moves `userRegistry` PENDING→WIRED (leaving only `preferences`). The union reader + projection already shipped (WS2.6). New e2e round-trip.

Channel-keyed identity — the local `userId` NEVER crosses. `upsertUser→persistUsers` fires emitPut for every surviving user; `removeUser` fires the channel-keyed emitDelete tombstone.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.userRegistry.enabled`) — **pass-through** — pre-existing; `userRegistry` becomes a registered emit target. Default false ⇒ no-op.
- `UserManager.persistUsers` / `removeUser` emit funnels — **pass-through** — already fire; this attaches a real emitter at each long-lived instance.
- `ws2SendWiring` ratchet — **modify** — `userRegistry` reclassified PENDING→WIRED.

---

## 1. Over-block
No block/allow surface. The emitter never rejects a user write; null recordKey / null projection / over-cap is a counted no-op and the local write always succeeds.

## 2. Under-block
Not applicable (no block surface). **Honest capture-scope note** (the load-bearing caveat): the in-process emitter fires on the SERVER-PROCESS user-write paths — telegram (both modes) + slack inbound registration, which are the dominant user-creation paths. TWO secondary paths are NOT covered, by design, and are stated rather than silently dropped:
  1. The Slack org-permission **admin** route (`buildSlackRegistry` in routes.ts) constructs a per-request UserManager; reaching the emitter there needs RouteContext plumbing disproportionate to a secondary admin flow.
  2. The `instar user add` **CLI** runs in a SEPARATE PROCESS, so it can never fire the server's in-process emitter; the send-side snapshot reads the journal's own entries, not `users.json`, so a CLI-only user is a known gap.
This matches the accepted in-process capture scope of relationships/knowledge. A single write funnel (one canonical UserManager) would close both gaps and is a reasonable future refactor; it is out of scope for "identical wiring."

## 3. Level-of-abstraction fit
Correct layer. A shared attacher at the construction sites is the minimal change that captures the multiple long-lived instances without a refactor. The projection lives in `UserRegistryReplicatedStore` beside the receive-side schema.

## 4. Signal vs authority compliance
Compliant. No blocking authority. The emitter is additive/best-effort (the funnel swallows + counts faults; a user write can never fail because replication did). **REQ-M14 (Know Your Principal):** a replicated user record is UNTRUSTED peer data and is NEVER the authoritative answer to "who is this inbound sender?" — inbound-principal resolution stays LOCAL-ONLY (the local channel index always wins). The union read is advisory HIGH-tier. Per `docs/signal-vs-authority.md`.

## 5. Interactions
- Uses server.ts's single `replicatedRecordEmitter` via the shared `attachUserReplication` helper. Distinct store key/kind from the other WS2 stores. No double-fire (each instance rides its own persistUsers funnel; the same person on two instances collapses to one channel-keyed recordKey).
- Touches `server.ts` + `ws2SendWiring.ts` (the shared WS2-SEND files) → serialized on top of merged topicOperator; no parallel WS2-SEND PRs.

## 6. External surfaces
Dark by default (`multiMachine.stateSync.userRegistry`). Off ⇒ byte-identical single-machine behavior. On (multi-machine, opt-in): crosses the channel-keyed profile projection (name, channels, permissions) — never the local userId. Same at-rest honesty as relationships (transit encrypted; at-rest plaintext per machine). A received record is quoted `<replicated-untrusted-data>`, advisory only.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Replicated.** Path: `upsertUser/removeUser → persistUsers → emit → CoherenceJournal.emitReplicatedRecord → peer serve/apply → ReplicatedPeerStreamReader → userRegistryUnionReader`. Identity = channel set (the same person on two machines collapses to one recordKey). removeUser propagates a channel-keyed tombstone (no resurrection). Verified end-to-end by the new e2e (put round-trip + channel-set collapse + removeUser tombstone resolves to no-record).

## 8. Rollback cost
Trivial. Dark by default. Back-out = revert the server.ts + ws2SendWiring.ts change or set the flag false (instant, no migration). Receive-side + envelope schema already shipped, unaffected.
