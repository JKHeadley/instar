## What Changed
- **A held reply is no longer ended because a newer message exists.** A reply that could not be sent at once (Telegram unreachable, or the machine that sends to Telegram was away) used to be thrown away when it was finally retried if anything newer had appeared in the topic, including the same session's own "got it, looking into this now". The user got nothing and nobody was told (F1 in `docs/specs/native-conversation-base.md`). The timestamp review is removed on every agent with no setting. A held reply is now delivered when it can be. The only reply that is still ended is one whose exact text Telegram already accepted in the same place.
- **A late reply says so in its first line.** A session reply sent more than 5 minutes after it was written starts with "Late reply, written more than N minutes ago and held up in delivery. It answers an earlier message:". The session that wrote it gets one line saying it went out late, and whether the first line could be added.
- **Every ending has a reason, and the author is told.** A suppressed reply now always carries one of five stated reasons. A reply that definitely did not arrive is handed back to the session that wrote it, with one of three causes ("Telegram refused it", "it could not be sent before its attempts ran out", "it passed its delivery deadline") and a route to read its text (`GET /telegram/origins/operations/ID/text`, API token only). A reply whose delivery could not be confirmed gets the uncertain line ("It may have arrived. Do not send it again unless the user says it is missing.") and is never sent twice. The two topic notices are reworded so the uncertain one never says "did not reach you".
- **Older machines.** When the machine that sends to Telegram runs the previous release and ends a reply with no reason, the reply is replaced once with fresh times; a second reasonless ending leaves it unresolved, tells the session to check the conversation before repeating it, and keeps one record-only attention item per topic until it is resolved. After a lease change such a reply is never sent without the previous owner's own record.
- **Status.** `GET /telegram/origins/status` gains `heldReplies` (`lateDeliveries`, `recoveredUnderThreshold`, `lateUnmarked`, `ownerUnstated`, `definiteNoSession`, `neverHandedBack`), read at the 2026-11-25 review.

## What to Tell Your User
If one of my replies gets held up in delivery, it now still reaches you when the connection comes back, instead of being dropped because the conversation moved on. If it arrives more than five minutes late it starts with a short line saying it is late and which earlier message it answers. If a reply could not be delivered at all, I am told and can send it again.

## Summary of New Capabilities
- Held replies are delivered late and marked instead of being ended on a timestamp.
- Session lines for late, definitely failed and unconfirmed replies; `GET /telegram/origins/operations/ID/text` for the reply text.
- `heldReplies` counters on the origin status.

## Evidence
- `tests/e2e/telegram-origin-causal-retire-alive.test.ts`: on the production boot path, a session's acknowledgment and its reply recovered 20 minutes later are both sent; the reply carries the late first line, is marked once, and the session is told once.
- `tests/integration/telegram-origin-held-replies.test.ts`: hand-back lines with and without a running session, the purge horizon, owner verdicts, the reply-text route (device token refused, conversation check), the scan carrier.
- `tests/integration/telegram-origin-worker-recovery.test.ts`: a queued reply with a newer message in its topic is delivered (the old test asserted it was retired).
- `tests/unit/telegram-origin/held-reply-causal-retire.test.ts`, `held-reply-store.test.ts`, `session-delivery-notice.test.ts`, `tests/unit/telegram-origin-held-late-migration.test.ts`.
