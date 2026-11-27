# Side-Effects Review — Telegram media in the app's history (chat media §4.9, Telegram half)

**Version / slug:** `chat-media-telegram-inbound`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run yet`
**Tier:** 2 (spec-driven; a new replicated event kind and an inbound handler hook). Size: 9 source files (one new module), 1 extended e2e file, 2 new test files.

## Summary of the change

docs/specs/mobile-native-chat-media.md §4.9, third and fourth bullets, Telegram only (Slack is not part of this change).

- **New event kind `platform-media`** in `AppConversationStore`: `{eventId, kind, conversationKey: telegram:<topicId> | Slack key, messageId, platformMessageId, attachments, at, machineId}`. `eventId === messageId === derivedEventId('pm', key, platformMessageId)`, so the same platform message appends once. The validator refuses an app conversation key, a mismatched id, a bad platform id and any bad attachment. Indexing adds media references only (the download authorization, the store's size total, pulls); it never adds a messages row, a preview or a delivery state, so browse and the conversation list are unaffected. `platformMessageId` is a replicated known field; peers on an older version refuse the unknown kind (counted), never store it wrongly.
- **Admission reuse:** `prepareReplyFiles` was split; its open-check, size limits, reservation (disk floor and store cap) and snapshot are now `admitFileSnapshots`, used both by the agent reply path (with its confinement and credential wall, unchanged) and by the new `recordPlatformMedia`, which then sniffs the type, publishes the blob and appends the event (blob before event).
- **Telegram hook:** `TelegramAdapter.setInboundMediaHook`. The photo and document handlers call it after their download without waiting for it; the voice handler awaits it (at most 30 s) before transcribing, because its download is deleted afterwards. Errors are logged and swallowed. AgentServer sets the hook only when native media is on (`isMobileMediaEnabled`) and the conversation service exists; a failed copy (other than a duplicate) is reported as a degradation.
- **Download:** `GET /mobile/media/:sha256` accepts `ref=telegram:<topicId>`, authorized by an unpurged media reference in that topic. The app path is unchanged except that the attachment lookup now also resolves `platform-media` (`getMediaAttachments`).
- **Device history read:** `GET /telegram/topics/:topicId/messages` for a device: each Telegram row whose message id has a `platform-media` event gets `attachments` (the app history shape, with `bytes`); every row's text has `[image:<path>]`, `[document:<path>]`, `[video:<path>]` and `[voice:<path>]` replaced. The conversation list's Telegram preview gets the same replacement. Bearer reads are unchanged.

## Decision-point inventory

- Inbound media admission — add — invariant floors reused from the reply path (disk floor, store cap, size cap); no judgment.
- Download authorization for `telegram:` refs — add — invariant: an unpurged media reference in that exact topic, else 404.
- Device text path replacement — add — invariant pattern replacement (structure, not content judgment).

---

## 1. Over-block

- A Telegram file over 50 MiB, or arriving while the store is full or the disk is low, is not kept for the app (the session still gets it). The app then shows the row without attachments. Intended by §4.7.
- A hard-linked download is refused by the shared admission check; Telegram downloads are fresh files, so this should not happen.

## 2. Under-block

- The download route checks only that the hash is referenced in the named Telegram topic; it does not check that the topic is still mapped on this machine. All paired devices are the operator's (§4.8), so this matches the app path's trust model.
- The path replacement covers the bracketed tag forms the Telegram handlers write. Free text containing a path (an agent reply quoting one) is not rewritten; that existed before and is out of scope.

## 3. Level-of-abstraction fit

The event lives in the existing app conversation store (the spec's chosen store for app-sent platform messages); admission reuses the reply path rather than a third copy; the adapter only exposes a hook and knows nothing about the store.

## 4. Signal vs authority compliance

No new authority. The hook is signal-only toward delivery (it can never block or change what the session receives). The download authorization is a structural reference check.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points added; all decisions are deterministic floors.

## 5. Interactions

- Replication: a `platform-media` event marks its hashes wanted on landing, so peers pull the blob like a `media-message` blob.
- Purge: `POST /mobile/media/purge` already accepted `telegram:<topicId>` keys; it now has attachments to purge there.
- Orphan sweep: a blob published without its event (crash between the two) is reclaimed after 7 days, as for reply files.
- `getMessageEvent` is unchanged; a new `getMediaAttachments` is used by the download route and the pending-delivery resolver.
- Voice handling waits for the copy (bounded at 30 s) before transcription, so a voice note can reach the session slightly later when the copy is slow.

## 6. External surfaces

- iOS app: can read `attachments` on Telegram history rows and download with `ref=telegram:<topicId>`; the app needs an update to show them.
- Bearer API callers: no change.

## 7. Multi-machine posture (Cross-Machine Coherence)

- `platform-media` events: **replicated** through the existing `appConversations` kind; blobs are pulled by every machine like other app media. A Telegram file is recorded on the machine whose adapter downloaded it (the polling machine).
- An older peer refuses the new kind and counts it; nothing is stored wrongly there.

## 8. Rollback cost

Switch `mobilePairing.native.media.enabled` off: the hook is not set at the next boot and the download route answers 503. Reverting the PR leaves `platform-media` lines in conversation files; an older version skips them as invalid events (reported once per line, left in place) and its sweep treats their blobs as orphans after 7 days. No data migration.

---

## Second-pass review

Independent reviewer — Concur with the review. A download needs the hash recorded in the named conversation; every device-facing history read (local and pool) and the list preview strip server paths; the replicated validator binds the event id to the message id and a platform key; photo and document copies never block delivery, the voice copy waits at most 30 s and releases everything on failure, and the copy happens before the download is deleted. Note for a later step: purge and tombstone of `telegram:` conversations (Telegram topics are never deleted through the app today, so no current path leaves files behind).
