---
title: "Unread messages for app conversations: a read marker per person, unread counts, and the app badge"
slug: "mobile-unread-messages"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-unread-messages.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); approved by the coordinating Echo session on 2026-11-07, which relayed Justin's 15:32 PST request in the app conversation linked to topic 134088"
lessons-engaged: "decentralized-by-default; updates-never-restrict-existing-agents; dark-on-fleet-is-live-on-echo; every-warning-needs-a-path-to-act; instar-agent-no-telegram-required; Cross-Machine Coherence; Bounded Notification; Signal vs Authority; Verify the State, Not Its Symbol; Archiving May Never Mean Deleting; Never Silently Cut the Data a Decision Depends On"
review-convergence: "2026-11-08T00:27:11.037Z"
review-iterations: 6
review-completed-at: "2026-11-08T00:27:11.037Z"
review-report: "docs/specs/reports/mobile-unread-messages-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

## 1. Problem statement

Operator request: Justin, 2026-11-07 15:32 PST, written in the native app conversation linked to Telegram topic 134088, relayed verbatim to this session by the coordinating Echo session:

> "need a button to jump down to the bottom that shows how many new messages there are that the user has not read yet. This should be synced with whatever chat platform is linked to the conversation, such as telegram or Slack and the unread messages for that platform. However, if it's just a native Instar chat, it should still have the ability to track unread messages and notify and show the user both on the list of conversations and within an individual conversation. Again, just like Telegram."

Today the app has no notion of read or unread: the list shows a title, a preview and a time; a conversation opens at its newest message; the app icon has no badge; nothing on the server records what a person has read.

Scope: the **server half** — the read marker, unread counts on the list and the history reads, the read report, the push badge — and the contract the iPhone app builds on (§7). The app's screens are built in `apps/instar-ios` against that contract.

## 2. What exists (instar main 8d81ecb24b, read from code)

- **List.** `GET /mobile/conversations` (`src/server/mobileConversationRoutes.ts`) merges app conversations (`AppConversationStore.listConversations`), Telegram topics (`deps.telegramTopics()`: `lastActivity` = the newest row of this machine's Telegram log) and Slack conversations (`deps.slackConversations()`). `?scope=pool` asks every peer for its own page with the **agent's Bearer token** (`fetchPeers`, :181-205), rebuilds each peer row from a fixed field list (`sanitizePeerConversation`, :125-141), merges, then hides rows the phone may not use (`visible()`, :438-442). Peer Slack rows are never listed.
- **App conversations.** One append-only JSONL per conversation plus a SQLite index; `messages(canonicalKey, eventId, at, …)` indexed on `(canonicalKey, at, eventId)`, no role column; message kinds `message` and `media-message`, roles `operator | agent`, an operator row may carry `senderRole`/`senderPerson`. Every event replicates to every machine (`AppConversationsReplicatedStore`, kind `app-conversation-event`, landed through the commit observer at `server.ts` ~5707 and the boot peer-stream load ~9984).
- **Telegram.** One per-machine log `telegram-messages.jsonl` (not replicated). `getTopicHistory(topicId, limit)` serves from an in-memory tail of the newest 500 rows per topic, filling it with one scan of the log on a miss; the list itself already calls `getTopicHistory(topicId, 1)` for every mapped topic (`AgentServer.ts` ~6624), so every listed topic's tail is already in memory when the list is built. Rows: `fromUser`, `telegramUserId?`, `teamPhone?`, `senderPerson?`, `senderRole?`, `via: 'mobile-device'`, `eventId?` (set only on rows typed in the app), `messageId` (Telegram's number), `timestamp`. The history route keys rows `e:<eventId>` or `m:<in|out>:<messageId>` and pages on time.
- **Slack.** `mobileSlackRoutes.ts`: operator copies from the app store plus `bridge.history(conv, 1000)` (a parse of up to 5000 lines / 8 MiB of `slack-messages.jsonl` per call, no cache; only `lastActivity` is cached for 10 s). Rows carry `eventId` (an app eventId or `slack:<ts>`), role `operator | participant | agent`, `at` from whole seconds. A Slack id is local to its machine.
- **People.** `devicePersonOf(req)` → `{ role: 'owner' | 'msp' | 'team', userId }`; all owner phones are one person and the role is the only stable owner key; `deviceMayUse(svc, req, ref, op)` is the one conversation-access check; `OwnerIdentity` carries `telegramOwnerId` and `slackOwnerUserId` (`mobilePairing.slackOwnerUserId`).
- **Push.** `MobilePush.onAppReply` sends an APNs alert for an agent reply in an app conversation, fanned out to every machine (each pushes to the phones registered with it), folded and rate-bounded per device, filtered per phone by `mayNotify`. No `aps.badge`. No push for Telegram or Slack messages.
- **Replication machinery.** A replicated kind registers `{kind, store, schema}`; the generic peer-stream reader keeps the latest record per `(origin, recordKey)` by HLC; landing into a store is the store's own ingest. Stores are dark on the fleet unless turned on; app conversations are turned on with native chat at `server.ts:5857`. A refused emit (per-kind token bucket, `CoherenceJournal.ts:389`) is dropped, not retried.
- **Platform read state.** Telegram's Bot API has no read receipts and no way to read or set a person's read position (only a user account over MTProto can). Slack read cursors belong to the calling token's user; the agent holds a bot token only.

**Decisions taken before this spec** (the coordinating Echo session, 2026-11-07, approving the plan): no Slack token for the owner's own account for now (the status quo); the Instar marker plus "your own reply marks everything before it as read" for Telegram and Slack, said plainly in the app; the cross-machine path chosen in this review.

## 3. Proposed design

### 3.1 Reader, conversation reference, message position

- **Reader key**, always from `devicePersonOf(req)`, never from a body or query (except the peer forwarding of §3.5): `owner` for every owner phone; `msp:<machineId>:<userId>`; `team:<personKey>`. A Bearer request has no reader. A phone whose person does not resolve has no reader and gets no read fields.
- **Conversation ref**, canonicalised before the access check and before any key is derived: `app:<lowercase uuid>`, `telegram:<integer topic id>` (no leading zeros), `slack:<machineId>:<negative integer>`.
- **Message position** `{ atMs, id }`: `atMs` is integer milliseconds since the epoch (never compared as text — sources write different ISO precisions); `id` is the message's id as the app already derives it: app → `eventId`; Slack → the history row's `eventId`; Telegram → `eventId` when present, else `in:<messageId>` for a `fromUser` row and `out:<messageId>` otherwise. Order: `atMs` numerically, then `id` by code units. One shared function computes this for counting, for `readUpTo`, and for validating a report; the app uses the same rule.

### 3.2 Markers and the baseline

- A **marker** `{reader, ref, atMs, id, updatedAt}` is the position of the newest message the reader has seen. It only moves forward: a write that is not after the stored position is a no-op.
- A **baseline** `{reader, sinceMs}` is set once per reader, the first time that reader's **phone** is seen by a machine running this feature (a device list read or read report — never a Bearer read), then replicated.
  - **Where `sinceMs` comes from:** the earlier of two values, both taken at creation:
    - the origin's hybrid logical clock, read through `ReplicatedRecordEmitter.clock`. It never runs behind any time the machine has already seen from its peers;
    - the origin's own wall clock. This stops a time learned from a peer whose clock runs ahead from producing a future baseline that would hide new messages until real time caught up. The value is kept in the state file and never changes after creation.
  - **Merge:** the earliest `sinceMs` wins.
  - **No clock check on landing**, so every machine converges on the same baseline. The residual risk: a machine whose clock is badly behind, and which has seen no peer time yet, sets an early baseline. That machine's existing conversations then count back to that time. Each count is bounded at "100+", the person reading clears it, and the hybrid clock pulls the time forward as soon as the machine sees any peer. This is accepted rather than adding a validation rule that would make machines disagree. A conversation with no marker counts only messages after the baseline: conversations that existed before the update start quiet (no "99+" on every old conversation at once), and conversations that start or get messages after it count normally — a new topic or an agent-started app conversation shows its unread before it is ever opened. A reader with no baseline yet (the very first read) gets its baseline set during that read, so it sees 0 then and real counts afterwards.
- Markers and baselines are never evicted. Their number is bounded by readers × conversations that exist: a report is stored only for a conversation the holder has, for a person it can resolve (§3.5). A marker is removed only when its conversation is gone (app conversation tombstoned; Slack conversation dropped from the registry) or its reader no longer resolves (a revoked team person or MSP user). Removal is local garbage collection, not a replicated delete. `ingestReplicated()` refuses a record only on **positive evidence of removal stored on this machine**:
  - a tombstoned app conversation (stored by the app store);
  - a revoked person (stored by the pairing and team records);
  - a Slack conversation this machine dropped from its registry. The marker store keeps these refs in a `removedRefs` list in its state file, so the refusal survives a reboot.

Telegram markers are never removed. A topic's session ending unregisters the topic but leaves it listed, so there is no stored deletion event to act on. "Not known here yet" is never removal: a marker that arrives before its conversation or person (they replicate separately), or for a Telegram topic this machine has never held, is kept. So a removed marker does not come back from a peer's stream at boot, and a marker is never lost to ordering. A soft threshold of 20,000 markers per machine raises one `DegradationReporter` report ("read markers growing past expected size") and drops nothing; the replicated kind deliberately has no `maxRecords` cap.

### 3.3 Storage and replication

- Per machine: `state/conversation-read-markers.json` (markers and baselines), held in memory, flushed atomically (tmp + fsync + rename, mode 0600) at most every 5 s and on shutdown. State-coherence registry entry `conversation-read-markers`: scope `must-be-coherent`, freshness `eventual`, conflictShape `lww` with the note "monotonic per key: the furthest position (earliest baseline) wins; order-independent", transport `peer-http`, retention class with a size note. Added to `BackupManager`'s default includes.
- Replicated kind `conversation-read-marker`, store key `readMarkers`, added to `JournalKind`/`JOURNAL_KINDS` with a retention entry, and turned on with native chat in the same injection as `appConversations` (`server.ts:5857`) so the fleet gets it wherever native chat is on (not only on development agents). recordKey `sha256(reader \0 ref)` (`ref = '*'` for the baseline). Schema: reader and ref shapes as §3.1, `atMs` a non-negative safe integer, `id` ≤ the history routes' own id bound (`eventId` limits of `validateAppEvent`; `in:`/`out:` plus a Telegram message number; `slack:<ts>`), `sinceMs` a safe integer. **No clock check on landing** — validity is decided once, at the origin (§3.5).
- Landing: the commit observer and the boot peer-stream load call the marker store's own `ingestReplicated()`, which applies the forward-only merge (the furthest position, the earliest baseline). Landing a record never triggers an emit. A machine emits only its own local advances. Its state only moves forward, so each origin's stream is itself monotonic and the reader's per-origin latest-by-HLC fold is safe.
- Emits are throttled per key, not postponed: the first advance of a key emits within 10 s and later advances of the same key are folded into at most one emit per 10 s, so continuous scrolling still shares a position at least every 10 s. Each key keeps `emittedPosition` in the state file; a flush and every boot emit every key whose position is past its `emittedPosition`, so an advance accepted before a crash or a refused emit (the journal's rate bucket) is shared after restart — the state file is the outbox. Basis for 10 s: a person scrolling produces several reports a second for the same conversation and only the last position matters to peers; 10 s bounds how stale another machine's count can be, far below the time it takes to pick up another phone.
- **Journal retention for the kind:** the journal's ordinary bounded window, with no special retention. The journal carries **live** advances between running machines.
- **State that has rotated out of the journal reaches a machine through a boot catch-up:**
  - At boot, and when the existing pool health check sees a peer come back after being dark, a machine asks each reachable peer for its merged marker state. The route is Bearer `GET /mobile/conversations/read-markers?cursor=`, over the existing pool peer path: at most 16 peers, a 5 s timeout per page.
  - It is paged at 2,000 records per page, in `recordKey` order, and followed until the end, so the catch-up is complete whatever the state's size. A key written behind the cursor during the catch-up arrives through the live journal.
  - **Recovery.** A catch-up that fails partway, on a timeout or a page error, keeps its cursor per peer in the state file. It retries every 5 minutes while that peer is reachable, until it completes. Nothing is left half-merged for ever.
  - **Baseline after catch-up.** A phone read served before the first catch-up has finished (or failed) creates no baseline yet. Its rows show no count until then, so a fresh local baseline never briefly overrides an earlier replicated one.
  - It merges what comes back with the same forward-only rule.
  - Every machine holds the whole merged state, so any one reachable peer is enough. A new or rebuilt machine, or one that was offline past the journal window, catches up without the journal keeping old records. A key whose origin has gone dark is still held by every other machine.
  - The catch-up is the same merge as landing, applies the same removal evidence, and never triggers an emit.
- `emittedPosition` advances only on an `accepted` or `deduped` emit outcome. `rate-limited` or `locked-out` leaves the key due.
- Landing and catch-up set `emittedPosition = max(emittedPosition, landed position)`, so a key learned from a peer is never re-sent at the next boot.
- Registry retention class: `fixed-cardinality`, one current record per reader × conversation.

- Why replication and not forwarding to the conversation's holder: the pool list asks every machine for its own page and app conversations live on every machine, so every machine needs the markers; forwarding would still have to fan the marker out, i.e. replicate it, with an extra hop and a holder that can be dark.

### 3.4 Counting unread

For one reader and one conversation **held on this machine**:

- **Effective position** = the later of the reader's marker (else the baseline, else none ⇒ count nothing and set the baseline, §3.2) and the reader's own newest message in the conversation ("your own reply marks everything before it as read").
- **An own message is stored.** When counting finds an own message after the stored marker, the marker is advanced to it as an ordinary local advance and replicated. This includes a forwarded `reader=` pool read whose key resolves, which is exactly the Telegram-handoff case. A Bearer read still never creates a baseline. The inference therefore isn't lost when that message ages out of the bounded history. A machine whose log lacks the reply, for example after a Telegram handoff, still learns it.
- **Own messages**:
  - App: operator rows sent by this reader (owner: `senderRole` absent or `owner`; others: `senderPerson` names them).
  - Telegram: owner — rows whose `telegramUserId` equals `OwnerIdentity.telegramOwnerId`, or `via: 'mobile-device'` rows with `senderRole` absent or `owner`; others — rows whose `senderPerson` names them.
  - Slack: operator rows sent by this reader (as for app), and for the owner, rows whose Slack user (`platformUserId` in the log, `user` in the API ring — read directly by the counting parse, since `SlackHistoryRow` drops it) is `slackOwnerUserId`.
- **Counted** = every chat message after the effective position that is not the reader's own:
  - App: `message` and `media-message` events (not `transcript`, `delivery`, `platform-media`), agent rows and other people's operator rows.
  - Telegram: agent rows and other people's rows.
  - Slack: agent and participant rows, and other people's operator rows.
- **Pre-filter**: a row whose `lastActivity`, in milliseconds, is more than one second before the effective position is 0 and is not read further.
- **Walk backwards from the newest message**, comparing positions numerically in code (§3.1). Stop at the effective marker position, at the reader's first own message (which becomes the effective position), or after 100 counted messages. Stored `at` values are text of mixed precision, so no SQL range on `at` is trusted for the cut-off. Only rows past the pre-filter are walked:
  - App: the existing `browseMessages(key, null, 100)` newest page, which is one indexed query plus one read per row.
  - Telegram: `getTopicHistory(topicId, 100)`, served from the tail the list has just touched, so there is no new disk read. Its rows are already full log entries; the typed accessor is widened so authorship fields are readable.
  - Slack: one parse of the existing log tail (5000 lines / 8 MiB, the bound `bridge.history` already uses) per list request, shared by every Slack row and cached by the file's size and modification time.
- **No change to how Telegram history is kept.** The counting reads only what the list already loads.
- **Mixed timestamp precision.** Stored `at` text can differ in precision, so the text order and the numeric order can disagree near a boundary. The walk therefore continues for one second past the stop point before stopping, and the pre-filter compares milliseconds. A tie within the same second always walks.
- **Exact or honest**: `unreadCount` is exact when the walk reached the position. When it did not — more than 100 counted, or the inspected window (the Telegram tail, the Slack tail) ends before the position — the row says `unreadMore: true` with `unreadCount` = what was counted, which the app shows as "N+". Basis for 100: the history routes' own existing page maximum (`limit ≤ 100` at mobileConversationRoutes.ts:727, mobileSlackRoutes.ts:203, AppConversationStore.ts:887, routes.ts:20906), so a count never claims more precision than one page the app could open.
- **Cache**: one cached count per (reader, conversation), replaced when recomputed and valid while its key holds: `(effective position, the conversation's local revision)`. The local revision is the app store's newest `ingestSeq` for the conversation, so a late replica changes it; the Telegram tail's append counter; or the Slack tail's size and modification time. Size: one entry per (reader, conversation) listed, the same order as the markers.
- **Unknown but new**: every row with a reader also carries `hasUnread`, which needs no walk. It is true when the row's `lastActivity` is not more than one second before the effective position. This is the same one-second margin as the pre-filter, so a message with the same timestamp and a later id is never missed. When a walk was done, `hasUnread` is simply `unreadCount > 0` (or `unreadMore`). When a count is unknown (the source isn't available on this machine) the app still shows that something is new (§3.7).

**Accepted limits, stated:**

- A message that reaches this machine late (replicated after a peer was offline) with a time earlier than the reader's marker is shown in the conversation but not counted as unread.
- After a Telegram topic moves between machines, the pool list takes the row (and its count) from the machine with the newest activity. Unread rows still sitting only in the previous holder's log are not counted, and app-typed rows logged on the other machine don't trigger the own-reply rule there.

Both undercount, never overcount. Both are rare and brief. Tracking per-message delivery to each reader to close them would cost a record per message per reader, out of proportion to a count.

### 3.5 Routes

All behind `mobilePairing.native.enabled` (503 when off) **and** `mobilePairing.native.unread.enabled` (default true when absent; false ⇒ no read fields, the read route 503s, no badge) so unread can be switched off alone.

- **`GET /mobile/conversations`.**
  - For a device reader each row gains `hasUnread`, `unreadCount` (integer ≥ 0, absent when unknown), `unreadMore` (only when true) and `readUpTo` (`{atMs, id}` or null). Counts are computed only for rows that pass `visible()`.
  - **The page total:** the response's `unreadTotal` is the sum over this page's visible rows. `unreadTotalMore` is true when any counted row had `unreadMore`, or when any visible row has `hasUnread` but no count.
  - **Beyond the page:** `unreadBeyondPage` is true when any visible conversation after this page has `hasUnread`. That check is the cheap pre-filter, with no walk. Under `scope=pool`, the asking machine ORs each peer's answer, and also sets it when any visible row the merge dropped past the page limit has `hasUnread`. The app shows the Chat tab total with a "+" when either flag is set, so unread outside the first page is never silently dropped from the total.
  - Under `scope=pool`, the asking machine forwards the reader to each peer as `&reader=<key>`. A peer honours it only on a Bearer request, i.e. the agent's own pool read, and only for a well-formed key; it ignores it on a device request. The peer resolves the key to a person through its own people records, team log and grants, applies that person's access to each row, and leaves the fields out when the key doesn't resolve there (for example an MSP user registered on another machine). A Bearer read never creates a baseline. Anything holding the agent token can already read every conversation in full, so the only new exposure is read positions.
  - `sanitizePeerConversation` passes `hasUnread`, `unreadCount`, `unreadMore` and `readUpTo` through after type and range checks.
  - App rows are counted by the asking machine itself, since it holds every app conversation, and peers' app counts are ignored. Telegram rows take the count from the machine that listed them.
  - A peer too old to count leaves the fields absent, and the app shows that row's count as unknown.
- **`GET /mobile/conversations/read-markers`** (catch-up between the agent's own machines).
  - Bearer only. It is not in `DEVICE_ALLOWLIST`, so no phone can reach it. It answers this machine's merged markers and baselines.
  - Anything holding the agent token can already read every conversation in full, so it exposes nothing new beyond read positions.
- **History reads** (`GET /mobile/chat/app/:key/messages`, `GET /mobile/chat/slack/:id/messages`, `GET /telegram/topics/:id/messages`): for a device reader the response gains `readUpTo` (the effective position) so the app can place the "Unread messages" divider.
- **`POST /mobile/conversations/read`.**
  - Body `{ marks: [{ ref, id, atMs, machine? }] }`, 1–50 marks.
  - **Who may use `reader=`.** A device-signed request ignores it. A Bearer request without it is refused with 400 (the agent itself has no reader).
  - **Access on a forwarded mark.** On the `reader=` path the holder checks `svc.mayUse(personOfReaderKey(key), ref, 'read')` itself. `deviceMayUse` lets every Bearer request through, so it is not used here. The list's `reader=` path applies the same check to each row.
  - **How a peer turns a key into a person** (one named function, `personOfReaderKey`):
    - `owner` → the owner;
    - `team:<k>` → resolved through the team log;
    - `msp:<machineId>:<userId>` → resolved only when `machineId` is this machine, so a same-named user on another machine is never taken for the same person;
    - a key that doesn't resolve answers `reader-unknown-here`. The phone keeps that mark, as it does a `pending` one, and the phone's own marker covers the conversation. Basis for 50: the app's list page size, 50 conversations, and the app sends at most one mark per conversation. A larger "mark all read" is split into pages, as the list is.
  - For each mark:
    - canonicalise the ref;
    - require `deviceMayUse(ref, 'read')` on a device request, or `mayUse(personOfReaderKey(key), ref, 'read')` on the `reader=` path;
    - look up `id` among this machine's messages of that conversation (app index; the Telegram tail; the Slack tail);
    - when this machine doesn't hold the conversation, forward the mark **once** to the machine that does:
      - a Slack ref goes to the machine the ref names;
      - a Telegram or app ref goes to the row's `machine` from the list, which the phone sends with each mark;
      - forwarding is a Bearer `POST /mobile/conversations/read?reader=<key>`;
      - a request that carries `reader=` is never forwarded again, so there are no loops and no pool-wide fan-out;
      - with no `machine`, or when that machine can't be reached, the answer is `pending`;
    - on the machine that holds the conversation:
      - if it holds the message itself, the stored position is this machine's own position for that message;
      - if it holds the conversation but not that message (an older message beyond the Telegram tail or the Slack log tail), it accepts the phone's position `{atMs, id}` but limits it to no later than the newest message it holds. A report can therefore never mark a future message read; at worst it marks older messages read, for that reader only;
    - advance forward-only;
    - schedule the coalesced emit.
  - A mark for a conversation the holder doesn't have, or one the person may not use, gets the same answer, `unknown-conversation`. A refusal therefore never reveals whether a conversation exists. It does not affect the other marks.
  - The phone drops `unknown-conversation` marks. It keeps `pending` and `reader-unknown-here` marks: one per conversation, the furthest, and sends them again later.
  - Answer `{ results: [{ ref, ok, readUpTo?, unreadCount?, unreadMore?, error? }] }`. Safe to repeat, so no request id.
  - Its own rate bucket: `{ ownBucket: 60/min, bucket: 'read-marks' }`, so read reports never draw on the shared device allowance the emergency stop relies on.
  - `DEVICE_ALLOWLIST` gets `conversationRef: true` and `body: 'json'`, and `TEAM_ROUTE_TIERS` gets tier `guest` (reading is guest), both in `src/server/mobilePairingRoutes.ts`.

### 3.6 Notifications and the app badge

- **App-conversation unread only.**
  - The reply push carries `aps.badge` = the receiving phone's reader's unread total over **app conversations only**. App conversations and markers are on every machine, so once replication has caught up every machine computes the same number. Until then, which is at most the 10 s throttle plus transport, a push may carry a slightly stale number in either direction. The next push or the app's own refresh corrects it.
  - It is summed only over conversations that reader may use (`mayUse(person, ref, 'read')`), and it counts the triggering message even if its replica has not landed yet.
  - If the person does not resolve or the count fails, the badge is left out; the push still sends.
- **Why the badge leaves out Telegram and Slack**: those apps badge their own icons, and the agent pushes nothing for them (Bounded Notification: no second notification for the same message).
- **The icon number between pushes**: when the app is open or refreshes, it sets its icon from the Chat tab's full total (all platforms). A push can therefore briefly show a different number from the Chat tab: a smaller one because Telegram and Slack are left out, or a stale one during replication. The spec states this rather than promising one number everywhere.
- **No push when a total reaches 0**: the app clears its own badge.

### 3.7 Contract for the app

- **List and Chat tab.** Show `unreadCount` per row ("N+" when `unreadMore`), and the sum on the Chat tab. A row with `hasUnread` but no count shows a dot (new messages, number unknown). A row with neither shows nothing.
- **Opening a conversation.** Open at the first message after `readUpTo`, with an "Unread messages" divider. If that message is older than the loaded page, open at the oldest loaded message, with the divider above it. With `readUpTo: null`, open at the newest message and report it.
- **Reporting read.** Each mark carries the row's `machine`. As messages come into view, keep the furthest message per conversation and send it at most every ~1.5 s and on leaving. The ~1.5 s is an app-side debounce and fits inside the 60/min bucket. Keep unsent marks across restarts, and clear counts on the phone at once.
- **Jump button.** A floating jump-to-bottom button when scrolled up, showing how many unread messages are below.
- **Older agents and refusals.**
  - **404, an older agent.** Keep the marker on the phone only, per agent and per conversation. Upload those marks once the route answers, and the server's forward-only merge decides. The conversation info says: "Read status isn't shared between your phones until this agent updates."
  - **403, not allowed.** Keep the phone-only marker, but never say an update will fix it. The refusal stays a refusal.
  - **Pending marks.** The phone lays its pending marks over the counts it shows, so a count it has just cleared doesn't come back on the next refresh.
  - **A mark limited by the holder.** When the answer's `readUpTo` is earlier than what the phone sent (the holder limited it to the newest message it has, during replication lag), the phone keeps the mark and sends it again later.
- **Telegram and Slack conversation info.** Shown once: "Read here in Instar. Messages you read in Telegram [Slack] itself aren't known here, but anything before your own reply there counts as read."

## 4. Bounds

| Bound | Value | Basis |
|---|---|---|
| Count precision | exact to 100, then "N+" with the true count's existence never hidden | judgment within a floor: the floor is "never claim a number smaller than what was counted, and always flag more" (`unreadMore`); 100 is the history routes' existing page maximum (four call sites), so a walk costs one page the app could read itself. A legitimate need for an exact count above 100 (rare in a chat list) still gets "100+", and nothing is lost |
| Marks per request | 50 | judgment within a floor: the floor is that no mark is lost (a larger batch is split, as the list is paged); 50 is the app's list page size (`Conversations.swift`, `limit=50`), one mark per conversation |
| Read route rate | 60/min per device, own bucket | judgment within a floor: a refused report is kept on the phone and resent, so the limit delays and never drops; the app's ~1.5 s debounce produces ≤ 40/min while scrolling; a separate bucket keeps the shared device allowance (relied on by the emergency stop) untouched |
| Emit throttle | at most one per key per 10 s, first within 10 s | judgment within a floor: correctness doesn't depend on it (forward-only merge, durable `emittedPosition`); it bounds how stale another machine can be |
| Boot catch-up | ≤ 16 peers, 5 s per page, 2,000 records per page, paged to the end | external-constraint: the existing pool peer-read bounds (`fetchPeers`). A page of 2,000 × ~300 B ≈ 600 KB sits well inside the existing peer byte caps. Paging makes it complete at any size |
| File flush | ≤ every 5 s and on shutdown | judgment within a floor: memory is authoritative while running; a crash loses at most 5 s of positions, which the next report restores |
| Marker count alarm | 20,000 per machine, report only | a signal, not a limit: nothing is dropped |
| Telegram counting window | the existing 500-row in-memory tail | existing behaviour; beyond it the count is "N+" or unknown, never a disk scan on the list path |

## 5. Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Who may write or read a marker for a conversation (`deviceMayUse(ref, 'read')`) | invariant; basis: enumerable-domain; evidence: the existing conversation-access check over the closed role set owner/msp/team, reused unchanged | Authorization stays deterministic and in one place (Know Your Principal). |
| A report must be for a conversation the holder has. The stored position is the holder's own for a message it has; otherwise it is the phone's position, limited to the holder's newest message | invariant; basis: enumerable-domain; evidence: whether the conversation is held, and its newest message, are lookups on the holder | Removes future markers and junk markers. An older client-reported position can only lower that reader's own count. |
| A mark for a conversation held on another machine is forwarded once to the machine the phone names | judgment-candidate; floor: never forwarded twice, never stored without the holder's own access check, unreachable ⇒ `pending` kept on the phone; arbiter: the holder's answer | Depends on reachability, so it is not an invariant; the floor keeps it bounded and lossless. |
| The holder limits a position for a message it doesn't hold to no later than its newest message | invariant; basis: enumerable-domain; evidence: "newest message held" is a lookup on the holder | No report can hide a future message; older positions only lower that reader's own count. |
| Marker only moves forward; earliest baseline wins | invariant; basis: enumerable-domain; evidence: a total order on (atMs, id) per §3.1 | Concurrent and replayed writes from many phones and machines converge in any order. |
| Count exact to one page, then "N+" | invariant; basis: external-constraint; evidence: the history routes' existing `limit ≤ 100` | Counting never claims more precision than the app could read. |
| No marker ⇒ count after the reader's baseline | judgment-candidate; floor: never more than the messages since the baseline, never negative; arbiter: the product default chosen here (first view after the update starts quiet, new activity counts) | A product default that can be changed later without data loss: the baseline is a stored time. |
| Own reply marks earlier messages read | judgment-candidate; floor: it can only lower a count, applies only to messages authored by this reader per recorded fields; arbiter: the operator-approved rule (§2 decisions) | An inference, not an observation (§6), so not an invariant. |
| Badge scope = app conversations the reader may use | invariant; basis: enumerable-domain; evidence: app conversations are replicated to every machine and `mayUse` is the access check | One number every machine can compute identically, never leaking another person's activity. |

> This feature produces a signal (counts, a badge, a divider). It blocks, filters and gates nothing beyond the existing access check.

## 6. Verification (Verify the State, Not Its Symbol)

| Symbol | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|
| `unreadCount` | messages after the reader's position, not the reader's own | computed from the conversation's own messages and the stored position on every read; tests cover each platform's own/other rules | fields absent ("unknown"), or `unreadMore` when the window ended early; never 0 by default |
| `readUpTo` | where the person stopped reading | set from a message the holder has, named by the person's phone. When the holder doesn't have that exact message (older than its tail), the phone's position is limited to no later than the holder's newest message, so it can only mark that reader's own older messages | null (open at the newest) |
| badge | app-conversation unread for this person | the same counting function as the list | badge omitted, push still sent |
| own reply | an inference that the person read up to it: the operator-approved rule, and how Telegram and Slack's own clients behave. The state it can't verify is reading itself, so it is used only to lower counts and is never shown as "read by" | authorship fields recorded by the platform adapters | not applied (count unchanged) |

## 7. Multi-machine posture

- **Read markers and baselines: unified, replicated.** Live advances travel through kind `conversation-read-marker`, with a forward-only merge in the store's own ingest. Older state arrives by the boot catch-up from any reachable peer. It is turned on wherever native chat is on (§3.3).
- **Telegram history stays per machine, as it is today.** `machine-local-justification: physical-credential-locality`. The log is written by the machine whose bot token polls Telegram. Counts over it reach every phone through the pool read; this spec adds no new per-machine state.
- **Unread counts: proxied-on-read.** Each machine counts the Telegram and Slack rows it lists, and the asking machine counts app rows. The pool merge carries the counts with the reader forwarded (§3.5). A dark peer's rows are already absent, shown as `pool.failed`, and the app treats them as unknown.
- **Badge: unified.** Computed from replicated app conversations and replicated markers.
- **App, older-agent fallback.** The phone keeps its own marks only until the agent can take them, then uploads them (§3.7). This is a client-side compatibility shim, not a server surface.

No machine-local server surface is introduced.

## 8. Agent awareness and update path

- **Maturation path.** The feature rides `mobilePairing.native.enabled`, which is already development-agent gated: live on a development agent such as Echo, dark on the fleet until native chat graduates. Unread therefore follows native chat's own test-agent → development-agent → fleet path, with no separate fleet switch-on. `mobilePairing.native.unread.enabled` can turn unread off alone.

- `CapabilityIndex` `appConversations`: add `POST /mobile/conversations/read` and the read fields to the description and endpoint list.
- CLAUDE.md template (`generateClaudeMd`): one line saying the app shows per-person unread counts and that the agent's own Bearer reads carry no read fields. Plus a `migrateClaudeMd` addition behind a content-sniff guard.
- No config migration: `mobilePairing.native.unread.enabled` reads as true when absent. The state file is created on first write.

## 9. Rollback

- `mobilePairing.native.unread.enabled: false` turns off counts, the badge and the read route alone. Native chat off turns off everything, as today.
- Reverting the release leaves the state file and journal records unread, and the app falls back to phone-only markers on a 404.
- No migration, and nothing rewritten.

## 10. Tests (planned)

- **Unit:**
  - position and order across platforms: ms comparison, Telegram `in`/`out` ids, Slack `slack:<ts>`;
  - forward-only merge: order independence, replay, an older write ignored, the earliest baseline;
  - reader keys for owner, msp, team, bearer and person-unknown;
  - ref canonicalisation;
  - counting per platform: own reply, other people in a shared topic, transcripts excluded, a page past 100, the window ending early, no marker plus a baseline;
  - marker removal for tombstoned conversations; the alarm reports without dropping;
  - the replicated kind's schema; coalesced emit with retry after a refusal.
- **Integration:**
  - list counts for a device and none for Bearer; `unreadTotal` excludes rows an MSP phone may not see;
  - a pool read with a peer carrying counts (the reader forwarded, the sanitizer keeps the fields);
  - the read route: it advances; it refuses a conversation the holder doesn't have and a forbidden conversation with the same answer; it limits a position for a message the holder doesn't have to the holder's newest message; it accepts a repeat; it uses its own bucket; on the `reader=` path it applies `mayUse` (not `deviceMayUse`); a mark for a Telegram message held only on a peer is forwarded there and lowers that peer's count;
  - sustained scrolling still emits at least every 10 s; an advance flushed before a simulated crash is emitted at boot;
  - an idle Telegram topic (no session) gets a count from the tail the list loads; a marker arriving before its conversation is kept; forwarding happens once and never loops; a mark for a message beyond the tail is limited to the holder's newest message;
  - a machine started empty catches up every marker, including untouched baselines and keys whose origin is dark, from one reachable peer, and emits nothing for them at its next boot;
  - a catch-up page that fails is retried from its saved cursor without a restart; a baseline never takes a future time from a fast peer clock; a message with the marker's timestamp and a later id sets `hasUnread`; `hasUnread` survives the peer sanitizer;
  - the catch-up pages to the end above 2,000 records; an own reply found while counting is stored as a marker and survives the message ageing out; a row with `hasUnread` and no count sets `unreadTotalMore`; a merged-away unread row sets `unreadBeyondPage`;
  - app rows with mixed `at` precision across the walk's stop point are counted correctly;
  - history routes carry `readUpTo`;
  - team guest admission;
  - the push payload badge, filtered by access.
- **E2E:** the feature is alive through the production wiring (routes answer 200, not 503) with native chat on, and the `readMarkers` store is enabled under the fleet's native-on config.

## Maturation plan

- **test-agent-live:** the stand-in agent in the app's UI tests and a throwaway agent with native chat on, driven from the simulator.
- **dev-agent-live:** Echo, on Justin's phone, across its machines (owner phones, an app conversation, a Telegram topic and a Slack conversation).
- **fleet:** there is no new fleet switch. Unread rides `mobilePairing.native.enabled`, which is dark on the fleet today, and reaches each agent when native chat does. `mobilePairing.native.unread.enabled` turns unread off alone.
- **graduation criterion:** on Echo, for a week, every unread count Justin sees matches what he has actually read, across two phones and two machines. That is no "stuck" count that reading doesn't clear, and no new message without a count or a dot.
- **ladder:** mobilePairing.native
- **dark-window:** if Echo hasn't run this for a week within 30 days of the merge, record why on the Maturation board with a new date.

## Frontloaded Decisions

- Cross-machine path: replication with a forward-only merge (§3.3).
- No Slack token for the owner's own account; no Telegram or Slack push (§2, §3.6).
- First view after the update: quiet for existing conversations, live for new activity (the baseline, §3.2).
- The Chat tab total covers the first page, plus a "+" when there is unread beyond it (§3.5).
- The badge counts app conversations only; the app's icon shows the full total when it refreshes (§3.6).
- Late-arriving messages and Telegram handoffs undercount and are documented (§3.4).

## Open questions

*(none)*
