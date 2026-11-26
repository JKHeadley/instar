# Side-Effects Review — Slack media in the app's history (chat media §4.9, Slack half)

**Version / slug:** `chat-media-slack-inbound`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run yet`
**Tier:** 2 (spec-driven; an inbound handler hook on the Slack adapter and a new download ref form). Size: 8 source files, 1 extended e2e file, 2 new test files.

## Summary of the change

docs/specs/mobile-native-chat-media.md §4.9, third bullet, Slack only. Reuses the Telegram half (`platform-media` events, `recordPlatformMedia`, `deviceTextForRow`).

- **Slack hook:** `SlackAdapter.setInboundMediaHook`. `_handleMessage` calls it, without waiting, for each downloaded file that produced an `[image:]` (photo), `[document:]` (file) or `[voice]` (voice) tag; a shared text file inlined into the message is not handed over. `_handleFileShared` hands over its single file, keyed by the id its log row carries (`file-<fileId>-<ms>`). The copy is bounded (30 s race), errors are logged and swallowed.
- **Conversation key:** AgentServer resolves the routing key with the adapter's own `resolveRoutingKey`, then the registry's `mintForInbound` (the same get-or-create the Slack inbound dispatch performs for that routing key) and `resolve(id).key`. That is exactly the key the app store and `GET /mobile/chat/slack/:id/messages` use. The hook is set only when native media is on, Slack and the registry exist, and the conversation service exists. A failed copy (other than a duplicate) is an `AppMedia.slackInbound` degradation.
- **Per-file ids:** platform message id `<ts>` for file position 0 and `<ts>:<i>` for position i, so every file of one message is its own idempotent event.
- **Key shape:** `PLATFORM_CONVERSATION_KEY_RE` (also used now by the purge route instead of its own copy) accepts `slack:_:<channel>[:<thread>]`, the registry's unknown-workspace placeholder. Reads and downloads also look under the placeholder variant of a concrete key, so files recorded before the registry learned the workspace keep showing.
- **Download:** `GET /mobile/media/:sha256?ref=<Slack canonical key>`. Authorized only when `slackHeld(ref)` — this machine's registry resolves the key to a Slack entry it minted itself (origin not `replicated`) whose CURRENT key equals the ref — and the hash is referenced in that conversation. App and Telegram paths are unchanged.
- **Device history read:** `GET /mobile/chat/slack/:id/messages` from a device: each Slack-typed row from the user gets the files recorded for its ts as `attachments` (app history shape), and every Slack log row's text goes through `slackDeviceText` (the adapter's two "at <path>" text-file notes, then `deviceTextForRow`). The response carries `conversationKey`. The list preview gets the same replacement (the preview is now cut to 140 after the replacement, so a cut cannot leave half a path). Bearer reads unchanged.

## Ref design decision

The ref names the conversation by its registry canonical key (`slack:<team>:<channel>[:<thread>]`), returned by the history read as `conversationKey`. The machine-local negative id is not used in the ref because it means nothing on another machine, and a canonical key alone could name a conversation another machine holds. So the route serves a Slack ref only when THIS machine's registry minted that conversation and the ref is its current key: the same rule the Slack history read enforces with `machine` (409 wrong-machine), applied without a second parameter. A phone that lists a conversation from machine A downloads its files from machine A. The blob itself may be on another machine; the existing 202 fetching path pulls it.

## Decision-point inventory

- Inbound Slack media admission — add — invariant floors reused from the Telegram half (disk floor, store cap, size cap); no judgment.
- Which Slack files are handed over — add — invariant: the tag the session received (image/document/voice); inlined text files skipped.
- Download authorization for Slack refs — add — invariant: registry-held-locally + current key + unpurged reference in that conversation, else 404.
- Device text path replacement for Slack rows — add — invariant pattern replacement.

---

## 1. Over-block

- A Slack file over 50 MiB, or arriving while the store is full or the disk is low, is not kept for the app (the session still gets it).
- A shared text or snippet file that the adapter inlined is not kept, so the app shows its text but cannot download the original. Deliberate: it keeps `[document:]` naming aligned with recorded files.
- A Slack conversation listed on machine B (replicated entry) cannot download its files through B; the phone uses the machine that lists it, which is how Slack conversations already work.
- After the registry upgrades a conversation's workspace, a ref still using the old placeholder key answers 404; the phone gets the new key from its next history read.

## 2. Under-block

- Any paired device can download a file referenced in a Slack conversation this machine holds; all paired devices are the operator's (§4.8), matching the app and Telegram paths.
- A message in a thread whose routing key is the channel (thread sessions not enabled) is recorded under the channel conversation, whose history does not show thread replies; that file is downloadable through the channel key but not shown. Matches where the session received it.
- Free text with a path (an agent reply quoting one) is not rewritten; out of scope as before.

## 3. Level-of-abstraction fit

The adapter only exposes a hook with the message facts; the server maps routing key → registry key → store, reusing `recordPlatformMedia`. The Slack-specific helpers live beside the Telegram ones in `appPlatformMedia.ts`.

## 4. Signal vs authority compliance

No new authority. The hook never blocks or changes what the session receives. The download check is a structural registry and reference check.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points added.

## 5. Interactions

- The hook calls `mintForInbound` for the routing key before the dispatch does; the dispatch's own mint for the same routing key is then a cache hit. No new conversations are minted beyond what the dispatch already mints (the hook runs only after authorization and the mention gate, on a downloaded file).
- Replication, purge and the orphan sweep behave as for Telegram `platform-media` events. Purge now accepts `slack:_:…` keys.
- `attachmentRows` is exported from mobileConversationRoutes for reuse; no behaviour change.
- The Slack list preview cache stores up to 2048 characters per conversation instead of 140 (bounded by the conversation count).

## 6. External surfaces

- iOS app: reads `attachments` on Slack history rows and `conversationKey`, downloads with `ref=<conversationKey>`; needs an update to show them.
- Bearer API callers: no change.

## 7. Multi-machine posture (Cross-Machine Coherence)

- `platform-media` events: **replicated** through the existing `appConversations` kind; blobs are pulled by every machine. A Slack file is recorded on the machine whose adapter received the message (the serving machine).
- Downloads by Slack ref: **machine-local by design** — only the machine whose registry minted the conversation serves it (see Ref design decision). Its blob may come from a peer through the existing pull.

## 8. Rollback cost

Switch `mobilePairing.native.media.enabled` off: the hook is not set at the next boot and the download route answers 503. Reverting leaves `platform-media` lines under Slack keys; the previous version (the Telegram half) already validates Slack keys with a concrete workspace and refuses `slack:_:` ones (reported, left in place), and its sweep treats their blobs as orphans after 7 days. No data migration.

---

## Second-pass review

## Second-pass review (independent, 2026-11-02 21:15 PST)

Concur with the review. One minor gap noted, not a blocker: the Slack history route refuses with 503 `slack-owner-unset` until the operator's Slack user id is set, while the media download route does not check it. A phone can reach a file only if it already knows both the file hash and the conversation key, which the history route never gives it while the id is unset. Closed in this PR: while the id is unset, the download route treats every Slack conversation as not held here (404), the same as an unknown conversation.
