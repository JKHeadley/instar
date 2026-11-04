# Side-Effects Review — files from the app into Telegram topics and Slack conversations

**Version / slug:** `chat-media-app-to-platform`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not yet run`

## Summary of the change

Increment 3 of docs/specs/mobile-native-chat-media.md §4.9. The Telegram send route (`POST /mobile/chat/:topicId`, src/server/mobilePairingRoutes.ts) and the Slack send route (`POST /mobile/chat/slack/:conversationId`, src/server/mobileSlackRoutes.ts) now accept the signed `attachments` an app conversation send takes, when `mobilePairing.native.media.enabled` resolves on. The upload start route (src/server/mobileMediaRoutes.ts) accepts `telegram:<topicId>` and a held Slack canonical key as the upload's target. The preflight, idempotency-hash parts, record-size ceiling and the claim → verify → publish → append order moved out of the app conversation route into src/server/mobileMediaSend.ts, used by all three routes. Mirrors: a new `TelegramAdapter.sendMediaToTopic` (multipart through `telegramFetch`, so through the origin outbox) with pure helpers in src/messaging/telegramMedia.ts; for Slack, the bridge gains `uploadFile` over `FileHandler.uploadFile`, which now takes an optional thread, message beside the file, and file name. The Telegram history join for devices (`joinTelegramHistory`) handles `media-message` events. CLAUDE.md awareness: one new bullet in the App conversation media section, migrated in place; CapabilityIndex updated. AgentServer wires `telegramTopicExists` into the media router and the media flag into the Slack router.

## Decision-point inventory

- Upload target admission (`POST /mobile/media/uploads`) — modify — the target may now be a known Telegram topic or a held Slack key, besides a live app conversation.
- Telegram/Slack send with attachments — modify — was a flat 400; now a media send when the flag is on, the same 400 when off.
- Attachment preflight (upload belongs to this device and this conversation, signed fields equal) — pass-through (moved, not changed) — now also applied to Telegram and Slack refs.
- Mirror method choice (photo/video/voice/file, media group, 50,000,000-byte cut) — add — deterministic mapping from the Bot API's own limits and method set.
- Telegram history join for a `media-message` — add — the device row shows the stored caption and attachments with the verdict.

---

## 1. Over-block

The Telegram mirror sends a file above 50,000,000 bytes as a text line instead of the file; that is Telegram's Bot API upload limit, so the file could not go up anyway. A mixed set (a photo plus a document, or voice notes) goes up as a group of documents, because Telegram refuses mixed groups and voice notes in groups; the files still arrive, shown as documents. An upload made for an app conversation cannot be sent into a Telegram topic (409 `attachment-mismatch`): the phone must upload for the conversation it sends into, which the spec requires. No other new refusal.

---

## 2. Under-block

The operator's files are not scanned for credentials on this path, exactly as in app conversations: the operator is the sender, and the existing rule there is to signal credential-shaped text (`credentialShaped`, now including transcripts) and hide credential spans in the mirror caption. A credential inside a file's bytes would be copied into the Telegram topic or Slack channel by the mirror. This matches the app conversation path, where the operator's own files are not refused either; the agent's own replies keep the non-overridable file credential wall. Noted, not changed.

---

## 3. Level-of-abstraction fit

The media checks live once, in mobileMediaSend.ts, and all three send routes call them, so the three targets cannot drift. The Telegram upload goes through `telegramFetch`, the single egress door, so the origin outbox records and seals it like every other Bot API send; nothing new reaches the network on its own. The Slack upload reuses the existing `FileHandler.uploadFile` and its hostname check rather than a second upload implementation.

---

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface on content.

The new refusals are structural (an upload not belonging to this device and conversation, a record too large to store, media off), the same checks the app conversation path already applies. `credentialShaped` stays a signal.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The mirror choices follow Telegram's documented limits and method set (an enumerable domain).

---

## 5. Interactions

- **Shadowing:** media-off keeps the old 400 ahead of everything, so the text paths are untouched when the flag is off. With the flag on, a text-only send takes the same code path as before (no `attachments` → no media branch); the signed origin is now built before the reservation instead of after, which is pure (no side effect) and yields the same record.
- **Double-fire:** the mirror runs once per finished request; a retry answers the recorded result before any media step, so neither the dispatch nor the mirror repeats (integration-tested for both Telegram and Slack).
- **Races:** two requests naming one upload: the existing atomic claim lets exactly one through (the second gets 409 `upload-already-sent`). Blob publish and event append still have no await between them.
- **Feedback loops:** the Telegram media mirror is an operator mirror: no history row, no stall or promise tracking, like the text mirror. The Slack upload does not log a Slack history row of its own; the app message's copy in slack-messages.jsonl carries the store eventId as before.

---

## 6. External surfaces

- **Telegram:** new multipart Bot API calls (`sendPhoto`, `sendVideo`, `sendVoice`, `sendDocument`, `sendMediaGroup`) through the egress door, silent, with no token in any error text (unit-tested). A tokenless standby refuses instead of relaying, since bytes do not travel with the relay; the route only runs on the lease holder anyway.
- **Slack:** `files.getUploadURLExternal` / `files.completeUploadExternal` now optionally carry `thread_ts` and `initial_comment`. Existing callers of `uploadFile` pass neither and are unchanged.
- **Persistent state:** new `media-message` events under `telegram:<id>` and Slack keys in the replicated app conversation store, and blobs in the media store, counted toward the existing store cap. Already-supported key shapes.
- **Operator surface:** no dashboard change. The operator action (sending a file) is the iPhone app's.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

Replicated, as the rest of app media: the `media-message` and its blobs replicate through the existing app conversation store and the app-media-pull mesh verb. The send is accepted only on the serving-lease holder (Telegram) or the machine whose registry minted the Slack conversation; downloads by `ref` follow the existing rules (Telegram topic ref on any machine holding the record; Slack only on the machine that lists the conversation). The mirror is one voice: it runs on the machine that accepted the send.

---

## 8. Rollback cost

Turn `mobilePairing.native.media.enabled` off: both routes return to the old 400 and uploads to 503. Code revert is a plain patch. Stored `media-message` events under Telegram/Slack keys stay readable by the existing history and download code; the purge route removes their files.

---

## Conclusion

Clear to ship behind the existing development-agent-gated media flag. Follow-up worth noting: the operator's own files are copied into Telegram/Slack without a byte-level credential scan, matching app conversations; if that should change, it changes for all three targets in mobileMediaSend.ts.

---

## Evidence pointers

- tests/unit/mobile-media-to-platform.test.ts
- tests/unit/PostUpdateMigrator-appMedia.test.ts
- tests/integration/mobile-media-to-platform.test.ts
- tests/integration/mobile-native-media.test.ts (updated refusal tests)
- tests/e2e/mobile-native-media-alive.test.ts (app → Telegram case)

## Second-pass review (independent, 2026-11-02 23:13 PST)

Concur with the review. No blocking defect. The app-conversation send behaves as before (same hash parts, same check order, same refusals). A phone cannot send into a topic or Slack conversation this machine does not hold, or reuse an upload made for another conversation. The Telegram copy goes only through the origin outbox. Releasing the request id early cannot cause a double delivery. Gaps the review named, closed in this PR: Slack tests for a wrong-conversation upload and for an upload started while the owner id is unset; the emergency-stop text with attachments on the Telegram and Slack routes; the Slack route now reads the media flag live, like the Telegram route.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. Each send and its Telegram/Slack copy happens once per operator request from the phone, idempotent by requestId; a failed copy is recorded as `mirror: "failed"` and never retried. Not a self-triggered loop.

## Live contract evidence

Not run: Echo's Slack bot token was revoked 2026-07-01 (config `_teardownNote`), so `npm run test:contract` cannot reach Slack. `FileHandler.ts` carries a CONTRACT-EVIDENCE: EXEMPT marker naming this. The change adds only Slack's documented optional `thread_ts` and `initial_comment` fields to the existing v2 upload flow. Run the contract suite when Slack is re-provisioned.

- `unbounded-self-action` (marker commit): closure `n/a`, comment-only.
