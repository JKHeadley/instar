# Side-Effects Review — WhatsApp direct-message sender identity

**Version / slug:** `whatsapp-dm-sender-identity`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 4 code/test files plus 2 docs. `src/messaging/WhatsAppAdapter.ts`: a direct message whose chat id is a linked identity (`@lid` or `@hosted.lid`) is attributed by a new `resolveLidSender`: (1) a message sent by this account (`fromMe`) is the owner only in the account's own chat (when the account's own LID is known; without it, `fromMe` alone); (2) otherwise WhatsApp's phone-form alternate id for the sender (`key.remoteJidAlt`, phone JIDs only); (3) otherwise the owner only if the chat is the account's own LID; else null and the message is dropped with a log line naming the chat id. `PhoneUtils.isLidJid` now covers `@hosted.lid`, and `jidToPhone` returns null for both forms, so linked-identity digits are never read as a phone number. `src/messaging/backends/BaileysBackend.ts` passes `socket.user.lid` on connect. Class of problem: sender identity on an inbound channel decided by assumption rather than evidence. Found by the standing security review. User-visible effect: none in normal use (see 1).

## Decision-point inventory

- Linked-identity DM sender attribution — modify — deterministic resolution from WhatsApp-supplied fields; unidentifiable → drop.

---

## 1. Over-block

A linked-identity DM for which WhatsApp supplies neither a phone alias nor a self marker is now dropped. Owner self-chat is marked `fromMe` by WhatsApp and still works (unit + e2e). Authorized contacts arrive with a phone alias on Baileys 7 and are attributed to themselves. A message before the account number is known (not yet connected) is dropped, as before for unresolvable ids. Two further drops, both correct: (a) once the account's own LID is known, a message the owner sends from their phone to someone else (it syncs to the linked device as `fromMe` in that person's chat) is no longer treated as a command to the agent, and the agent no longer replies into that person's chat; (b) an authorized non-owner contact whose message arrives with no phone alias from WhatsApp is dropped (fail-closed) with a log line naming the chat id.

## 2. Under-block

The resolution trusts `remoteJidAlt` and `fromMe`. Both are built by Baileys from server-set attributes (`decode-wa-message.js`: `fromMe` compares `from` with the account's own id and LID; the alt id comes from `sender_pn`/`participant_pn`/`peer_recipient_pn`), not from message content. Remaining edges, unchanged by this PR and not stranger-reachable: if Baileys does not report the account's own LID, a `fromMe` message in another person's LID chat is still treated as the owner; owner messages to friends in phone-form chats are out of scope here. Group messages are unchanged (authorized by group; a linked-identity participant is never mapped to the owner there). The WhatsApp Business webhook backend does not produce linked identities.

## 3. Level-of-abstraction fit

Right layer: the adapter's single direct-message entry point, before rate limiting and the auth gate, so every downstream consumer (auth, consent, sessions) sees the corrected identity.

## 4. Signal vs authority compliance

- [x] Deterministic identity resolution from platform-supplied fields, feeding the existing auth gate. No content judgment.

## 4b. Judgment-point check

No new heuristic: an enumerable set of platform facts.

## 5. Interactions

- **Auth gate / consent:** receive the resolved number unchanged in shape.
- **Rate limit:** keyed by the resolved number, as before; dropped messages are dropped before it.
- **Read receipts:** still sent before resolution (unchanged order).
- **Double-fire / races:** none; pure function of the message key and adapter state.

## 6. External surfaces

None. No route, config, file format or UI change.

## 6b. Operator-surface quality

No operator surface.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine's WhatsApp connection resolves its own inbound messages; no new state.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration.

---

## Conclusion

Small fix at the single entry point, with tests on both sides that fail on the old code where they should. Second pass concurs; clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and Baileys source before this artifact)
**Independent read of the artifact: concur** on the authorization question (no stranger can be attributed to an authorized number; verified against the Baileys 7.0.0-rc.9 source). Two findings, both now fixed in this PR: owner-sent messages in other people's chats (now credited to the owner only in the account's own chat when its LID is known), and `@hosted.lid` slipped past the `@lid` check into the digits-as-phone path (now covered by `isLidJid`/`jidToPhone`). Test gaps it named are closed: a fromMe-in-another-chat case, a `@hosted.lid` case, and a wiring check that the backend passes the account LID.

---

## Evidence pointers

`tests/unit/WhatsAppAdapter.test.ts` → `linked-identity direct messages` (13 tests). The new drop cases fail on the previous code (checked 2026-11-16 with an old-vs-new harness, kept privately); owner self-chat and phone-form senders behave the same on both. `WhatsAppAdapter.test.ts` + `whatsapp-ux-signals.test.ts`: 74/74; `messaging-shared/PhoneUtils.test.ts`: 19/19; `tsc --noEmit` clean. The e2e file's two linked-identity cases were updated (self-chat now carries the `fromMe` key the real backend sends; the source check names the new resolver) and are left to Local Verify.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in a messaging adapter, closed by the unit tests above).
