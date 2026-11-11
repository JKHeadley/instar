# Side-Effects Review — relay-path row carrier and contiguous-ack watermark (Context Budget S3)

**Version / slug:** `cb-row-carrier`
**Date:** `2026-11-10`
**Author:** `Echo (builder session, Opus)`
**Second-pass reviewer:** `Fable 5.2 (findings and dispositions below)`

## Summary of the change

Context Budget Phase 1, slice S3 (spec `docs/specs/context-budget-layered-summaries.md` §14 "U bodies and the message-row source" and the topic-move clause, §18 Tier 1/2 lines). Rows are written on the machine whose adapter received the message (S2). This slice carries each message's TopicMemory row on the existing `deliverMessage` forward-to-owner path and lands it in the owner's TopicMemory before the receipt.

- `src/memory/topicRowWatermark.ts` (new): a SQLite store (`state/topic-row-carrier/carrier.db`). Sender side: a per-topic seq in this machine's stream (`<machineId>/<epoch>`, the epoch minted once per database), idempotent per message. Owner side: per (topic, stream) `contiguous` / `maxSeen` / `floor`, advanced only contiguously (a gap holds it; a seq that arrived without a storable row is a gap), the landed seqs with their row keys (the most recent 1000 per stream kept), unrecoverable seqs, the bounded list of every message id the owner accepted (with its sender), and pending moves.
- `src/memory/topicRowCarrier.ts` (new): `TopicRowCarrier` builds the carried row from the sender's stored row (S2 key rule fields, `channel_message_id`, `origin`, resolved person), validates a peer's row (typed and bounded, its stream bound to the signed sender), lands it through S2's `TopicRowWriter`, and answers `rowsPresent(topicKey)`. Routing ids are addressed in the adapter's shapes (`tg-<n>`, `slack-<ts>`). `TopicRowPullCoordinator` fills gaps from the stream's machine; on a topic's arrival (first accepted forward per (topic, ownership epoch), or this machine claiming the topic for itself) it durably marks the move pending and pulls the previous owner's recent rows and stream heads; it fetches accepted rows nobody carried by id from the machine that sent them; and a one-minute repair sweep retries all of it, including rows a TopicMemory rebuild lost. Pulls are bounded (500 rows, 2 MB, measured per row); a gap wider than one pull becomes the stream's visible floor; a seq, id or move no machine can supply after 5 tries (or a stream its machine no longer holds) is marked unrecoverable, counted on the status and reported (DegradationReporter), so no topic stays stuck without a state. `rowCarrierEnabled` = `contextBudget.enabled` resolved through `resolveDevAgentGate`.
- `src/core/SessionRouter.ts`: optional `carryRow` dep, read once per forward and attached to every `deliverMessage` attempt and to the placement hop (`spawnOnMachine`'s new optional 4th arg). A fault carries nothing; the message still goes.
- `src/core/DeliverMessageHandler.ts`: optional `landRow` dep, run after the stale fence, sender validation and the can-serve refusal, BEFORE `recordReceipt`, for every non-app command (a duplicate lands as a no-op). A fault never changes the ack.
- `src/core/MeshRpc.ts`: `deliverMessage` gains an optional `row` field; new read/observe verb `topic-row-pull`.
- `src/memory/TopicMemory.ts`: `getMessageByChannelId`, `presentMessageKeys` / `presentChannelIds` (chunked IN queries); a keyed replay that carries an origin labels an unlabelled duplicate (never changes an existing label).
- `src/commands/server.ts`: builds the store and carrier beside the row writer; router `carryRow`, both `deliverMessage` sends carry `row`; handler `landRow` with the signed sender (+ first-arrival pull per ownership epoch); the router's self-claim seam starts a move pull; the one-minute repair sweep; `topic-row-pull` handler; the pull coordinator on the signed mesh client with previous-owner evidence from the placement journal; `topicRowsPresent` now reads the carrier (was a constant `false`); the server's Slack synthetic-id hash now calls the shared pure `slackSyntheticTopicId` (identical arithmetic).

## Decision-point inventory

- `FoldPreconditions.topicRowsPresent` (`server.ts` → `FoldCoordinator`) — modify — was constant false; now true only when the carrier is on, TopicMemory is open and holds rows for the topic, no move pull is pending, every stream is contiguous to its highest known seq, every retained landed row is really in TopicMemory, and every accepted message's row is present (unrecoverable ones excepted, visibly).
- `DeliverMessageHandler` — modify — a new pass-through step (`landRow`) before the receipt; no ack value changes.
- `SessionRouter.forwardToOwner` / placement hop — modify — carries an extra field; no routing decision changes.
- `topic-row-pull` RBAC — add — read/observe class (registered same-operator peer), the handler is the gate (off ⇒ `disabled`; seq mode serves only this machine's own stream).

---

## 1. Over-block

No block/allow surface on messages: nothing the carrier does can refuse, delay or re-route a message. The only gate it feeds is the fold precondition, where it is deliberately conservative:

- A topic with any gap, any accepted message whose row is absent, or a TopicMemory rebuilt without carried rows reads `rows-missing` and does not fold. That is the spec's "else not clean ⇒ no fold"; folds are reversible maintenance, so refusing is the safe side.
- A topic on a machine with no rows yet (count 0) reads not present.
- With the switch off, `topicRowsPresent` is false everywhere (no fold), exactly as before this slice.

## 2. Under-block

- **Bounded pulls.** A gap wider than 500 seqs is cut: seqs below become the stream's `floor`, counted as contiguous, kept on the state (`status().floored`) and reported once as a DegradationReporter row. Rows below the floor may be absent on the new owner. The move pull's recent rows are also bounded to 500 and leave no floor of their own (the stream heads it reports still open gaps for anything carried). <!-- tracked: CMT-1536 -->
- **Unrecoverable rows are let go, visibly.** A seq whose stream machine has no row after 5 pulls, a stream its machine no longer holds (its carrier database was replaced: a new epoch), an accepted id the sender has no row for after 5 tries, and a move pull a previous owner never answers in 5 tries (backoff 30 s doubling, capped at 30 min) are marked unrecoverable: counted on `status().abandoned`, reported once, and no longer holding the topic. The fold then runs without those rows. A machine that is gone for good with no answer at all (unreachable, not "not my stream") keeps its gaps open: the topic stays unfoldable, the safe side. <!-- tracked: CMT-1536 -->
- **Rebuild detection is bounded.** A TopicMemory rebuilt from JSONL loses carried rows; the precondition re-checks every retained landed seq (the most recent 1000 per stream) and every retained accepted id (the most recent 500), and the sweep re-fetches them. A loss older than those windows is not detected. `carrier.db` is in no backup set; losing it mints a new stream epoch, so peers holding the old stream answer "not my stream" and those seqs go unrecoverable as above.
- **Previous-owner evidence.** For an accepted forward, the previous owner comes from this machine's journal replica (`topic-placement` entries); a lagging replica or a Slack topic names none, so no move is marked pending and only gap and id pulls run. The self-claim seam names the previous owner from the CAS itself. A genuinely new topic has no previous owner and is not held.
- **A refused message's row can still land later.** The seq is assigned before the forward; if the owner answers `sender-rejected`, that seq is a gap the next pull fills from the forwarder. The row is real topic history (the forwarder holds it too), not a delivery: the session never sees it. Accepted.
- **Rows the owner wrote itself are not in a stream.** If the owner was itself the adapter machine for a while (it held the lease), those rows are local; a later owner learns of them only through the recent pull from the previous owner (bounded to its 500 most recent rows), not through a seq. The accepted-message list covers every forwarded message regardless of stream.
- **Agent replies** are not carried: the owner writes its own outbound rows locally (S2), and the lease holder's copy is not forwarded. The holder's copy of a mirrored A2A send relayed through `outboundRelay` still lacks `origin` (the S2 gap); the owner's own row carries it, and this slice makes a carried or pulled row label an unlabelled copy, so a later owner that pulls from the standby gets the label. Threading `rowOrigin` through the three holder relay paths (`forwardReplyToHolder`, `relayOriginBot`, `relayOutbound`) is not done here. <!-- tracked: CMT-1536 -->
- **iMessage/WhatsApp** have no row writer (S2), so no carrier; `hasRowSource` already refuses their folds.
- **Previous-owner evidence** comes from the coherence journal's `topic-placement` entries (numeric topics). A Slack topic's move has no previous owner named, so only the gap pull from the forwarder runs; it still fills every seq the forwarder carried.
- The accepted-message list is bounded to the 500 most recent per topic.

## 3. Level-of-abstraction fit

The carrier rides the one path that already delivers each message to the owner at least once with a durable receipt (§14 names it), rather than adding a parallel replication channel. The row is landed through S2's writer (one key rule, counted refusals), not a second insert path. The watermark is a separate machine-local store beside TopicMemory, so a TopicMemory corruption rebuild cannot silently erase the record of what was carried; the precondition also re-checks TopicMemory directly, so a rebuilt TopicMemory cannot read clean on a stale watermark. Gap repair reuses the signed mesh client and the read/observe verb pattern of `topic-history-pull` / `topic-profile-pull`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The carrier never blocks a message, a send or a session. `topicRowsPresent` is a structural fact (are the rows in this database) feeding the fold coordinator's existing precondition chain; it can only refuse a reversible maintenance action.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Contiguity is an enumerable invariant (every seq 1..n landed). The two numbers (500 rows per pull, 500 expected ids) are bounds on one network request and one bounded list, each with its consequence named and visible (a floor on the state plus a degradation row; older accepted ids leave the check).

---

## 5. Interactions

- **Shadowing:** `landRow` runs after the stale fence, sender re-validation and the can-serve refusal, and before the receipt, so a refused message never lands a row and an accepted one always does first. The app arm returns before it (app rows come from the replicated store, S2).
- **Double-fire:** the owner may already hold the row (it was the adapter machine, or a pull got there first): the keyed insert answers `duplicate` and the watermark records the seq. A retry carries the same seq (idempotent per message), so a re-forward never opens a gap. The S2 writer's own Telegram/Slack rows on the forwarder are untouched.
- **Races:** the gap pull fires from `land` while the next carried row may land the same seq; both go through the keyed insert and `recordInbound` (`ON CONFLICT … COALESCE`), so the later one is a no-op. One pull per (topic, stream) in flight, 30 s cooldown.
- **Feedback loops:** a pull lands rows, which can only close gaps; `applyRecentPull` fires gap pulls, which never trigger another recent pull (the arrival pull runs once per topic per process).
- **Existing e2e:** `tests/e2e/context-layer-kind-alive.test.ts` asserted the constant `topicRowsPresent: () => false`; updated to the carrier wiring. Its behavioural assertion (no fold at boot) still holds.

## 6. External surfaces

- **Wire:** `deliverMessage` carries an optional `row` (≤ 64 KB text, else carried as missing). Older owners ignore it (tested: an owner without `landRow` answers `queued`). Older forwarders send none; the owner records the message as expected, so its precondition reads the row missing (tested). New verb `topic-row-pull`: an older peer answers `no-handler`, which the coordinator treats as no answer and leaves the gap visible.
- **Disclosure:** `topic-row-pull` serves this machine's own TopicMemory rows of one topic to a registered same-operator peer, the same rows the forward already delivers to the owner and the same class `topic-history-pull` serves. Bounded by the handler; the receiver re-validates every field.
- **Persistent state:** new `state/topic-row-carrier/carrier.db` (WAL). Not under `state/context-layers/`, so the S1 layer-store backup set does not pick it up.
- **Operator surface:** no operator-facing actions.
- No change to Telegram, Slack or app delivery, routing decisions, acks, or the receipt ledger.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated via the relay path (§14 "with a row carrier").** The rows follow the topic's owner: the forwarder carries each row on `deliverMessage` (the existing at-least-once path with a durable receipt), and a new owner durably marks the move pending, pulls the previous owner's recent rows and stream heads over the signed `topic-row-pull`, then fills gaps from the stream's machine, before its first fold (the precondition reads false while the move is pending or any gap, lost row or uncarried accepted row is open; the sweep retries until each is filled or visibly marked unrecoverable). The watermark itself is **machine-local by design**: it states what THIS machine's TopicMemory holds, which is exactly the fold's precondition on the owner. No user-facing notices (only DegradationReporter rows), no URLs. Durable state does not strand on transfer: the new owner pulls rather than inheriting a file. Skew: older peers on either end degrade to "no row carried", which reads as rows missing (no fold), never as a fold on a gap. Status surfaces: none new or changed (`status()` is an in-process read used by tests; no route).

## 8. Rollback cost

Pure code revert ships as a patch. The carrier database is inert to old code; it can be left or deleted. Rows already landed on owners stay as ordinary TopicMemory rows (keyed by S2's rule). With the switch off (the fleet default), nothing is carried and `topicRowsPresent` stays false, so no fold depends on it. No agent state repair, no user-visible regression.

---

## Conclusion

The carrier closes §14's "rows are on the wrong machine" gap on the path the spec names, with a contiguous watermark that a gap holds and a precondition that re-checks TopicMemory rather than trusting the watermark alone. During the build: the watermark moved out of TopicMemory (a rebuild must not silently read clean), the owner records every accepted message so an older forwarder's missing row still holds the topic, and a carried row's origin labels an unlabelled duplicate (part of the S2 relay-origin gap). The second pass found that Telegram ids were never addressed (the precondition read clean) and that a move did not hold the precondition; both are fixed, and every open state now either converges through the repair sweep or ends visibly as unrecoverable. Remaining gaps are in §2. Clear to ship dark (fleet default off; live on development agents).

---

## Second-pass review (if required)

**Reviewer:** Fable 5.2
**Independent read of the artifact: concern → resolved.** Two blockers, three majors, seven minors and two nits; every one is fixed or recorded below.

1. **(blocks) Telegram ids were never addressed.** The router is handed `tg-<n>`; `rowAddressFor` required a bare number, so nothing was carried or expected and `rowsPresent` read clean once the owner held any row. **Fixed:** `tg-` is stripped like `slack-`. Unit case for `tg-555`; the integration test now routes adapter-shaped ids for every message.
2. **(blocks) The move pull did not hold the precondition.** It was fire-and-forget, once per process, hooked to one seam, and nothing read it. **Fixed:** a durable `move_pending` marker per topic (newest ownership epoch wins), set at the accepted-forward seam (per (topic, epoch), previous owner from the journal) and at the self-claim seam (previous owner from the CAS); `rowsPresent` is false while it is set; cleared only by a real answer; retried by the sweep with backoff; given up visibly after 5 tries. Unit and integration tests cover an unreachable previous owner that later answers, and one that never does.
3. **(major) A rebuilt TopicMemory read clean after a sliding window with no repair.** **Fixed:** the precondition re-checks every retained landed seq (1000 per stream, not the last 200) and every retained accepted id, and the sweep re-fetches lost seqs from their streams. The remaining window is recorded in §2. Unit test drops a landed row and shows the sweep restoring it.
4. **(major) Gaps that can never close had no terminal state.** **Fixed:** `not-my-stream` marks the gap unrecoverable at once; a row-less seq after 5 pulls; accepted ids nobody carried are fetched by id (new `ids` pull mode) from the machine that sent them (recorded with the expectation), and marked unrecoverable after 5 tries; all counted on `status().abandoned` and reported; a later real row clears the mark. The sweep retries everything on a timer. A machine that never answers at all keeps its gaps (fails safe), recorded in §2.
5. **(major) Tests missed real id shapes and failure paths.** **Fixed:** cases added for adapter ids, pending/failed/abandoned move pulls, the self-claim seam (WIRED), rebuild loss, a dead stream, a row-less seq, an uncarried accepted id, and sender binding. The crash e2e still uses a hand-assembled handler with the production modules (the full server boot path is covered by the WIRED source checks).
6. **(minor) A refused message's row can land via a later pull.** **Accepted and recorded** in §2: it is real history the forwarder holds, never a delivery.
7. **(minor) `servePull` served any id and called negatives Slack.** **Fixed:** uses `rowChannelForTopicId`; app and review-canary ids answer `not-a-row-channel`. Tested.
8. **(minor) Byte trim re-stringified per pop.** **Fixed:** each row is measured once (`takeWithinBytes`).
9. **(minor) A byte-cut seq pull did not continue.** **Fixed:** `onGap` loops while the answer makes progress (bounded to 8 rounds).
10. **(minor) Extra commits per message.** **Partly fixed:** `expectRow` is one transaction and prunes only over the cap; `recordInbound` stays its own transaction (two per carried message).
11. **(minor) Heavy precondition.** **Fixed:** presence checks are chunked `IN` queries, not one read per id.
12. **(minor) Artifact gaps.** **Fixed:** §2 and §7 rewritten (id shape, rebuild window, unrecoverable states, no backup for `carrier.db`, the recent pull's bound).
13. **(nit) Stream not bound to the signed sender.** **Fixed:** the handler passes the verified sender; a carried stream from another machine is refused as malformed. Tested.
14. **(nit) Retries reused a null row.** **Fixed:** the row is read per attempt (the seq is idempotent).

---

## Evidence pointers

- Unit `tests/unit/topic-row-carrier.test.ts`; integration `tests/integration/topic-row-carrier-two-node.test.ts` (real signed mesh, two and three nodes); e2e `tests/e2e/topic-row-carrier-lifecycle.test.ts` (owner child processes killed between row and receipt, and before the row; WIRED checks on server.ts and MeshRpc.ts).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `n/a`
- **`closure`:** `n/a`
- **Reason:** a new capability on an existing delivery path, not a fix to an agent-authored artifact; its only self-triggered actions (gap and arrival pulls) are bounded per (topic, stream) with a cooldown and a once-per-process arrival pull, and they only read from peers.

## Amendment (CI)

CI's `SqliteRegistry-wiring` allowlist check failed: `topicRowWatermark.ts` opens a long-lived SQLite handle and already calls `registerSqliteHandle`, but the store was missing from the test's `LONG_LIVED_STORES` list. The fix adds it there. No runtime change.
