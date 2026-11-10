# Side-Effects Review — channel-neutral TopicMemory row writer (Context Budget S2)

**Version / slug:** `cb-row-writer`
**Date:** `2026-11-10`
**Author:** `Echo (builder session, Opus)`
**Second-pass reviewer:** `Fable 5.2 (on c5b09585a; findings and dispositions below)`

## Summary of the change

Context Budget Phase 1, slice S2 (spec `docs/specs/context-budget-layered-summaries.md` §14 "U bodies and the message-row source", §8 origin, §6.1 operator binding). Adds `src/memory/topicRowWriter.ts`: one key rule every machine derives identically (Telegram: native id; Slack: `ts × 1e6`, parsed exactly; app conversations: `physicalMs × 1000 + (logical mod 1000)`), a `TopicRowWriter` that writes through a new `TopicMemory.insertKeyedMessage` and counts every refusal, `hasRowSource(topicId)` for the fold precondition, and two channel adapters (`writeSlackLogRow`, `writeAppConversationRow`). `TopicMemory` goes to schema v6 with nullable `channel_message_id TEXT` and `origin TEXT` (through the existing `migrateSchema` path, idempotent) plus a partial unique index on `(topic_id, channel_message_id)`. `server.ts` routes Telegram rows with a real id, Slack rows (fixing the `messageId: 0` cast that collapsed a channel into one row; the sender now binds to the memory-privacy person resolver's user id) and, behind `contextBudget.enabled` read live, app-conversation rows through the writer, and hands the fold coordinator the writer's `hasRowSource`. `AppConversationStore` gains `addAppendListener` (fires on a new local or replicated commit; separate from the single replication hook). The Threadline→Telegram bridge stamps its mirrored rows `rowOrigin: relay` (inbound) or `a2a` (our own outbound), which `TelegramAdapter` carries onto the logged row and the JSONL import reads back. Files: `src/memory/topicRowWriter.ts` (new), `src/memory/TopicMemory.ts`, `src/core/AppConversationStore.ts`, `src/messaging/TelegramAdapter.ts`, `src/messaging/shared/MessageLogger.ts`, `src/threadline/TelegramBridge.ts`, `src/monitoring/foldCoordinatorBoot.ts`, `src/commands/server.ts`, three test files.

## Decision-point inventory

- `FoldPreconditions.hasRowSource` (`foldCoordinatorBoot.ts`) — modify — was "positive numeric key"; now asks the writer whether the topic's channel has a writer that is on (Telegram, Slack always; app only with `contextBudget.enabled`). Absent dep keeps the old answer.
- `TopicRowWriter.writeRow` key/collision decision — add — deterministic: derive key, insert, or refuse (`collision`, `key-mismatch`, `bad-key`, `not-ready`) with a count and a DegradationReporter row.
- Telegram/Slack TopicMemory dual-write — modify — same rows, now keyed and carrying the channel id; Slack gets distinct keys and a resolved `user_id`.

---

## 1. Over-block

- A Slack id that is not a `ts` (a standalone file share Slack gave no message ts for, or an operator message logged from the Instar app as `app-<messageId>`) is NOT refused: it gets a deterministic fallback key (2^52 + a 48-bit slot hashed from the id alone, above every `ts × 1e6` key until 2112) with the raw id as `channel_message_id`. Only an empty or oversized id is refused `bad-key`. A standalone file share now logs under the share's real message ts from `files.info` `shares`, then the event's `event_ts`, then `file-<fileId>` — never a clock read.
- A Telegram row with a non-positive id is NOT refused: it keeps the legacy `insertMessage` path unchanged.
- An app event for a conversation with no local alias yet is refused `bad-key` (counted). The app store remains the source of truth, so nothing is lost from the conversation itself; the row is absent from TopicMemory, which makes that topic read "not clean" for a fold rather than folding on a gap.
- Two app messages with the same millisecond and the same event-id slot (1 in 1000 per same-ms pair) collide; the second is refused and counted. This is the spec's stated behaviour ("a counted refusal, never a silent drop").

## 2. Under-block

- Slack agent replies DO produce rows: the reply route notifies `onMessageLogged` itself right after `logMessage`. `SlackAdapter.logMessage` now also notifies (so an operator message sent to Slack from the Instar app is a row); the reply route passes `notify: false` so a reply is notified exactly once.
- iMessage and WhatsApp have no numeric TopicMemory topic id space today; they get no writer in this slice, and `hasRowSource` is false for them (a fold refuses `no-row-source`), which is the spec's safe answer.
- A mirrored A2A row relayed through `outboundRelay` (a standby sending via the lease holder) loses its `rowOrigin`, because the holder writes that row from the relayed text. The bridge only mirrors from the voice owner, so this needs a standby to also be the mirror voice; carrying the field on the relay path is S3's row carrier.
- App rows missed while `contextBudget.enabled` was off, or refused, are replayed by a bounded reconcile from the AppConversationStore (the source of truth) at boot and whenever the switch turns on: at most the 500 most recent messages per live native conversation. Older messages beyond that bound are not replayed.
- TopicMemory opens without Telegram only when `contextBudget.enabled` is on AT BOOT; turning the switch on at runtime on a Telegram-less agent needs a restart before its rows (and folds) exist. Until then `hasRowSource` is false (it requires an open TopicMemory), so such a topic refuses to fold rather than folding on missing rows. <!-- tracked: CMT-1536 -->

## 2b. Spec deviation: the app-conversation key (§14) <!-- tracked: CMT-1536 -->

§14 says the integer key for app and other channels is derived from "the replicated HLC of the message". No such stored stamp exists: an app event's HLC is applied by the replication emitter when it emits (`buildAppConversationRecordData`), is not one of the event's fields, is not kept by `AppConversationStore`, and is never produced at all on a single machine (nothing is emitted). A key built from it could not be derived identically everywhere, which is the property §14 exists for.

The build therefore derives the stamp from the event's own immutable, replicated fields: `physicalMs` = the accepting machine's `at`, and `logical` = a slot (0–999) hashed from the event id. Consequences:

- The key is identical on every machine that holds the event (e2e: two separate processes derive the same keys).
- Two app messages accepted in the same millisecond collide with probability 1 in 1000. The second is refused with a counted `collision` (a DegradationReporter row), never silently dropped, and is not stored as a TopicMemory row; the store still holds it.
- This is recorded for the operator as a deviation from the approved spec text, not redesigned here.

## 3. Level-of-abstraction fit

The key rule lives in one pure function beside TopicMemory (the store it keys), not in each adapter, so every channel and every machine shares it. The collision check is inside a TopicMemory transaction (the only place it can be atomic). Channel adapters stay thin: they only translate their log entry into a `RowIdentity` and a `RowBody`. The fold coordinator does not learn channels; it asks the writer. No higher-level gate exists for row keying to feed instead.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The writer decides only whether a row is stored under a key; it never blocks a message, a send, or a session. The `origin` column is a label the later U/ledger slices read as "carries no authority", which narrows authority rather than granting it. `hasRowSource` refuses a fold (a reversible maintenance action) when a channel has no writer — a structural fact about the build, not a judgment on content.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The key rule is an enumerable invariant mandated by §14 (it must be identical on every machine, so it cannot be a judgment), and the topic-id → channel mapping reads the id spaces the channels mint (`conversationIdentity.ts`, `ConversationRegistry.mintAppAlias`).

---

## 5. Interactions

- **Shadowing:** the Telegram and Slack dual-writes keep their position in their `onMessageLogged` callbacks; PresenceProxy, skill-learning and stall tracking run after them unchanged. The writer never throws into the callback (reporting is wrapped).
- **Double-fire:** app rows are written on local append AND replicated ingest; the key is derived from the event alone, so a second arrival is `duplicate`, not a second row. The app store's replication hook is untouched (the listener is a separate set).
- **Races:** `insertKeyedMessage` runs in one SQLite transaction; concurrent writers on the same db serialise through better-sqlite3 (single process) and busy_timeout.
- **Legacy rows:** a pre-v6 Telegram row with the same id and no channel id is ADOPTED (channel id filled), not a collision; the JSONL import keeps `INSERT OR IGNORE` and also reads `rowOrigin`. The old collapsed Slack row (key 0) stays as history and never collides with a real `ts` key.
- **Feedback loops:** none. `insertKeyedMessage` no longer bumps `topic_meta.message_count` on a replay (the plain `insertMessage` still does, unchanged).

## 6. External surfaces

- Persistent state: TopicMemory schema v6 (two nullable columns, one partial unique index). An older build opening a v6 db ignores the columns and resets `schema_version` to 5; the next v6 open re-runs the idempotent column checks (tested).
- Slack TopicMemory rows now carry the resolved UserManager `user_id`, so `getRecentMessagesForUser` applies the existing `private`-scope rule to them (rows from another person are hidden from a user filter, as they already are for any row with a user id). Previously Slack rows had no user id and were visible to every filter.
- `SlackAdapter.logMessage` now notifies `onMessageLogged` (presence, skill-learning seam, TopicMemory rows) for the Instar app's operator messages to Slack, as Slack-native inbound messages already do. The agent-reply route opts out (`notify: false`) because it already notifies once itself; no subscriber sees a row twice.
- On an agent with no Telegram, TopicMemory now opens when `contextBudget.enabled` is on at boot (dark on the fleet: the switch is unregistered and defaults off).
- No change to Telegram, Slack or app message delivery, no new routes, no operator-facing actions. DegradationReporter rows appear only on a refusal.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Re-derived from rows, with a deterministic key (§14 "U bodies and the message-row source").** Rows are machine-local in TopicMemory, written on the machine whose adapter received the message (Telegram, Slack) or wherever the app event lands (local accept or replicated ingest). The KEY is the replicated part: it is derived only from fields every machine sees identically (Telegram id, Slack `ts`, the app event's immutable `at` and event id), so layer references `(message id, hash, length)` match across machines; the e2e test proves two separate processes derive identical keys. Carrying Telegram/Slack rows to a different owner is S3 (relay-path row carrier and watermark), not this slice. No user-facing notices, no URLs. The app-conversation topic id is this machine's alias for the conversation (machine-local by design: aliases are minted per machine), while the message key is identical everywhere. No status surface changes.

App HLC note: a stored app event carries no HLC (the replication emitter stamps one at emit, not part of the event, and a single machine never emits). The writer therefore derives the stamp from the event's own immutable `at` (physical) and a slot derived from the event id (logical), which is what makes the integer identical on every machine.

## 8. Rollback cost

Pure code revert ships as a patch. The two columns and the index are inert to the old code (it neither reads nor writes them), so no data migration is needed on rollback; the old Slack writer would resume writing key-0 rows, which is the pre-existing defect. App rows written while the switch was on stay as ordinary TopicMemory rows. No agent state repair, no user-visible regression.

---

## Conclusion

Clear to ship as a dark-for-app, correctness-fix-for-Slack slice. During the build the review changed three things: Telegram rows with non-positive ids keep the legacy insert (so no new refusal noise on an existing path), legacy rows are adopted rather than counted as collisions, and the app HLC is derived from the event's immutable fields because no stored HLC exists. The Fable 5.2 second pass found five issues and two nits; all are fixed or recorded (section below). The remaining known gaps (iMessage/WhatsApp writers, `rowOrigin` across `outboundRelay`, a runtime switch flip on a Telegram-less agent needing a restart) are listed in §2; the relay-path carrier is S3. <!-- tracked: CMT-1536 -->

---

## Second-pass review (if required)

**Reviewer:** Fable 5.2
**Independent read of the artifact: concern → resolved.** Five findings and two nits on c5b09585a; each is fixed or recorded in the section below.

## Second-pass review (Fable 5.2)

**Reviewer:** Fable 5.2, on commit c5b09585a. Every finding and its disposition:

1. **Standalone Slack file/voice shares refused `bad-key`** (`_handleFileShared` logged `file-<fileId>-<Date.now()>`). **Fixed.** The share logs under its real message ts from `files.info` `shares.public|private[channel]`, then `event_ts`, then `file-<fileId>` (`fileShareLogId`, no clock read). Non-ts Slack ids get a deterministic fallback key (2^52 + 48-bit slot from the id alone) with the raw id as `channel_message_id`. Tests: unit (`fileShareLogId` order, fallback key determinism and range), integration (a real `_handleFileShared` with Slack stubbed at the API client lands one row under the share ts).
2. **Operator messages sent to Slack from the Instar app got no row** (`logMessage` never fired `onMessageLogged`). **Fixed.** `logMessage` notifies (contained: a throwing subscriber never fails the log write); the agent-reply route passes `notify: false` because it already notifies once right after, so no subscriber double-handles. Checked subscribers: the server's chained Slack callback (TopicMemory, skill-learning seam, stall clear, PresenceProxy) and the SeamFilter/PromisedUpdateCapture chains, which wrap the same slot. Note: the app path's message id is `app-<messageId>`, not a ts, so finding 1's fallback key is what keys it. Tests: unit (fires once; `notify:false` does not), integration (a row lands with the operator's person), e2e source check (the reply route passes `notify: false` and notifies once).
3. **`hasRowSource` ignored whether TopicMemory exists.** **Fixed.** It now requires an open TopicMemory. TopicMemory also opens without Telegram when `contextBudget.enabled` is on at boot (a two-line change: the open condition and guarding the one `telegram.onMessageLogged` assignment). A runtime flip on a Telegram-less agent needs a restart; recorded in §2. <!-- tracked: CMT-1536 --> Tests: unit and integration (closed TopicMemory ⇒ no row source), e2e source check of the open condition.
4. **A refused or never-written app row was permanent.** **Fixed.** `reconcileAppConversationRows` replays from the AppConversationStore at boot and when the switch turns on (a `liveConfig` change event, plus an off→on transition seen by the append observer), bounded to the 500 most recent messages per live native conversation; the keyed insert makes the replay idempotent; a conversation with no alias is one counted refusal, not one per message. Tests: unit (missed rows replayed, idempotent, bounded, default 500, no-alias counted once, off ⇒ skipped), integration (a real store: the message stored while off is replayed), e2e source check of the boot and switch-on wiring.
5. **The app key departs from the spec's "replicated HLC".** **Recorded** as a spec deviation in §2b with its consequences and why no stored HLC exists; not redesigned (as instructed).
- **Nit: review-canary topics (-910_00x) classified as Slack.** **Fixed.** -910_000…-910_999 are reserved and map to no channel; unit test iterates `REVIEW_CANARY_FIXTURES`.
- **Nit: prepared statements in `insertKeyedMessage`.** **Fixed.** Cached per open database handle (a corruption rebuild opens a new handle and re-prepares).
- **Nit: version-string compare in `migrateSchema`.** **Not changed**, per the reviewer: it is the existing pattern.
- Also found while fixing 2: the app store holds Slack/Telegram conversations opened from the app under their platform keys; the app writer now skips any non-native key (`not-this-channel`) instead of refusing it, so those rows come only from the platform's own writer.

---

## Evidence pointers

- Unit `tests/unit/topic-row-writer.test.ts`; integration `tests/integration/topic-row-writer-channels.test.ts`; e2e `tests/e2e/topic-row-writer-lifecycle.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `n/a`
- **Reason:** one-shot event-driven action, not a self-triggered loop. The only "notify" this change adds is the row writer's DegradationReporter row on a refused write, emitted at most once per inbound message the writer is handed; it never retries, re-drives or re-fires on its own, so there is no control loop to converge.
- No agent-authored-artifact defect: the Slack key fix corrects source code, not a prompt, hook, config, skill or standards text.
