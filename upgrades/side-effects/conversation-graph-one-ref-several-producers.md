# Side-effects: one conversation reported by several machines is one available conversation

## Summary

The live two-machine proof of Conversations (Studio + M5, 2026-11-09) could not organize an app conversation. App conversations replicate to every machine by design, so both machines' source inventories recorded the same conversation. `materializeGraphSourceInventory` treated any ref recorded by two different producers as ambiguous: it withheld it from `conversations` and listed it as unavailable. Moves were refused `not-visible`, and the history route answered 404 `conversation-unavailable`. With app replication off, a conversation held by one machine was organizable.

Telegram topics hit the same rule on a multi-machine agent. A standby builds a send-only `TelegramAdapter`, and `getAllTopicMappings()` lists every known topic name, so every machine with Telegram configured produces an observation for each topic. The Telegram ref (`chatId` + `topicId`) does not name a machine, so two machines collide on it.

The change has two parts. `entries` stays one row per producer. `conversations` now holds one row per ref. For an app or Telegram ref seen from several producers, the display row is the one with the newest `lastActivity`, and a tie goes to the lowest `producerMachineId`. The choice uses only certified content, so every machine with the same certified union picks the same row, whatever order records arrived in. A Slack ref seen from two producers stays ambiguous and unavailable, as before.

Second, coverage now records which producer's checkpoint made a ref unavailable (`unavailableBy`): a prior observation whose local row is gone, or a checkpoint row whose observation is missing or invalid. For an app or Telegram ref, that producer's row is not used, and the ref leaves `unavailableConversations` when another producer still holds a usable row. Without this, one standby that stopped listing a topic, or listed one its registry could not resolve, would still hide the topic on every machine. Slack keeps the per-ref behaviour. A ref that no producer can supply stays unavailable, exactly as before.

### Why the rule existed

It came in with commit 772bd936c1 (2026-11-06, "owned custody, recovery, privacy and transfer performance"). The side-effects record for that work (`upgrades/side-effects/conversation-effort-hierarchy.md`, line 31) says: "Cross-producer ambiguity is unavailable rather than an arrival-order winner." So the rule was there to stop the inventory from picking a winner by which record arrived first. Spec §7.2 and §6 keep the same idea for history: no machine's copy wins by arrival. The rule did not separate refs that name a machine-local holder (Slack) from refs whose identity is global and whose history any machine reads through the pool (app, Telegram). Its own test fixture covered only Slack (the deliberate `-7` alias collision across machines). I found no lane note that names replicated app conversations or standby Telegram adapters as a reason to withhold. A deterministic content-based choice meets the stated intent (no arrival-order winner) for app and Telegram refs.

### What stays ambiguous

A Slack ref's row carries a machine-local negative alias and `machine` = the producer (`validRow` enforces `row.machine === producer`). The history route sends a Slack read to that one machine. Two machines reporting the same Slack channel/thread would name two different holders and aliases, so there is a real choice of holder that content cannot settle. That case still goes to `unavailableConversations` and marks the inventory partial. Slack's `nodeKey` is `{kind, platform, channelId, threadTs}` with no machine. So two machines' *different* Slack channels never collide even when their machine-local ids are equal (both `-7`); they stay two conversations, each with its own `machine`.

## 1. Over-block
Less than before: replicated app conversations and shared Telegram topics are no longer withheld. Slack withholding is unchanged.

## 2. Under-block
Could a ref that should be withheld now be shown? Only app and Telegram refs are merged. Their payload row is validated so that `row.id` equals the ref's own identity (`conversationKey` or `topicId`) and they carry no `machine`. Producers can differ only in title and `lastActivity`, which are display fields. Erasure is not affected. Erased observations carry `record.erasure`, never yield an entry, and are fenced locally; a `forgotten` or `deleted` checkpoint state goes through per-producer `coverage.removed`, which is unchanged. The one relaxation is the "unavailable" marker for app and Telegram refs. It now means "this producer no longer supplies it", not "nobody does". The sweep defines this state as absence of a local row, "never an inferred platform deletion". If every producer that holds the ref marks it unavailable, or it is Slack, it is still listed unavailable, and the projection still gives unavailable precedence over any row.

## 3. Level-of-abstraction fit
The choice lives in `materializeGraphSourceInventory`, the one place that turns per-producer observations into the conversation list. Every reader (read model, owner changes, history resolve, mobile graph routes) gets the same single row. Coverage only gains a record of who said "unavailable"; its existing fields keep their meaning.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`. Inventory rows are display and visibility only. Picking a display row grants no authority; placement still goes through owner changes and witness certification.

## 5. Interactions
- `ConversationGraphReplicationRuntime.inventory()` overlays this machine's live activity on `conversations` by ref. With one row per ref this behaves as before.
- `GraphProjection` keys conversations by ref. Before, duplicate rows would have overwritten each other in arrival order; now there is only one.
- `hasConversation` (owner changes) is now true for a replicated app conversation, so moves are accepted.
- History route: app and Telegram reads go to this machine's own server with `scope=pool`, never to a producer, and their rows carry no `machine`. So the producer that won the display row does not change where history comes from, and the post-fetch `freshSource` comparison (platform, id, machine) stays stable when the winning producer changes between the two resolves. Slack is unchanged.
- `entries` keeps every producer's row. Its only other consumer is a test that reads `entries[0].row.title` on a single-producer inventory.
- Delegation reads no inventory.

- One single-producer change: if a producer's latest checkpoint called a ref unavailable but its observation is newer (the row came back), the row used to stay in `conversations`. So owner changes were accepted on a ref the projection already showed as "Unavailable conversation". Now the row is left out until that producer's next sweep, and changes are refused `not-visible`. The projection itself looks the same.
- A producer with no checkpoint, or a checkpoint older than its observation, can supply a global ref over another producer's "unavailable". That producer is listed in `missingProducerIds` or `partialProducerIds`, so the inventory stays `partial`. A ref lost on one machine also keeps `partial` true through `missingObservationIds`/`partialProducerIds`, even while another machine supplies the row.
- Display-only limits: `lastActivity` is compared as a string, as the existing `entries` sort already does, so mixed offset/precision spellings are not strictly chronological. On a tie the lowest producer id wins, so a machine that missed a rename can show the old title until a newer activity arrives. Both choices are deterministic.
- The earlier record `upgrades/side-effects/conversation-effort-hierarchy.md` (line 31: "Cross-producer ambiguity is unavailable rather than an arrival-order winner") now holds for Slack refs. For app and Telegram refs it is replaced by the deterministic content rule here; that file is left as the historical record.

## 6. External surfaces
The graph read routes (dashboard and phone) now show replicated app conversations and shared Telegram topics as normal, movable rows rather than "Unavailable conversation". No wire format change.

## 7. Multi-machine posture
This is a multi-machine fix. Every machine computes the same row from the same certified union. A machine whose union is behind may briefly show an older title until it catches up, which is the same as for any certified row.

## 8. Rollback cost
Revert the commit. No state or format change; the inventory is recomputed on every read.

## Class-Closure Declaration
Defect class: replicated-identity-treated-as-conflict. Closure: the merge applies to every platform whose ref identity is global (app, Telegram). Slack, the only machine-scoped platform, stays explicitly ambiguous, and a test covers both sides.

## Evidence
- Live proof evidence: scratchpad `conv-proof/results.json` steps 3 and 6 (move refused `not-visible`, history 404 `conversation-unavailable` with app replication on; organizable with it off).
- tests/unit/conversation-graph-source-inventory-producers.test.ts: two producers of one app ref, two producers of one Telegram topic, and order-independence with a tie. Red before the change (3 failed, 2 passed: the two Slack cases pass either way), green after (5/5).
- The same unit file, through a substituted coverage result: one producer's checkpoint lost the app ref and the other still holds it, so the ref is available from the holder. When both lost it, it is unavailable. 6/6.
- tests/integration/conversation-graph-source-inventory.test.ts: new case with real signing, sealing and all-member witness certification. Both machines hold the same app conversation and Telegram topic, giving one available row each. The two machines' Slack conversations share alias `-7` and stay two rows.

- The same integration file had one failing assertion unrelated to this change. 'recovers a pending observation only from witness bytes…' expected the Slack channel title `private origin title`. Since e3d30dd092 (#2978, "channel titles start with '#'"), the flat producer writes `#private origin title`. The expectation is updated to the current producer output. That test reads `entries`, which this change does not alter.
- The commit hook's destructive-op lint refused every commit in this worktree because of `tests/unit/join-missing-dir.test.ts`, which arrived with the merged `fix/join-missing-dir-1109` and used a direct `fs.rmSync` in its cleanup. That cleanup now goes through `SafeFsExecutor.safeRmSync`; the test still passes 1/1.
- Focused runs: the unit file passes 7/7. Integration (source-inventory, surface, device-auth, replication-runtime) gave 44 passed, 1 failed (the title assertion above) before that fix; after that fix, the source-inventory file passes 19/19.

## Second-pass review
A fresh reviewer read the diff and the code paths without my conclusion. It reviewed twice.

First pass: concur, with one medium finding. Coverage marked a ref unavailable for all machines whenever any single producer's checkpoint did, so one standby could still hide a replicated app conversation or Telegram topic. This was not a regression, since those refs were withheld anyway. Fixed by recording `unavailableBy` and scoping that marker to its producer for global refs.

Second pass, on the revised diff: concur, no blocking findings. Erasure is per ref and marks every producer's records, so no other machine can bring an erased ref back. Slack is fully excluded from the new logic. The only other coverage reader (`ConversationGraphReadSource.replication()`) is unaffected. Its notes are applied in section 5: the single-producer behaviour change (now pinned by a unit test), producers without a current checkpoint, the display-only string and tie limits, and the qualifier on the earlier rule.

Not done: an integration case where a real sweep writes `unavailableBy`. Producing the 'unavailable' state needs a prior observation whose local app row is gone without a tombstone, and this fixture cannot make that cheaply. The unit case covers the decision through a substituted coverage result.
