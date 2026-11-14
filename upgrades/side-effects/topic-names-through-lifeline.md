# Side-effects review: topic names reach the server when the lifeline owns polling

## Change
1. `TelegramLifeline.processUpdate`: a topic-created or topic-renamed service message (no text) was dropped by `if (!msg.text) return;`. It is now passed on as a name-only forward (`text: ''`, `topicName`, `topicRenamed`, `nameOnly: true`). An ordinary message in a topic also carries the topic's name, because Telegram attaches the topic's creation message as `reply_to_message`; the lifeline now includes it as `topicName`.
2. `POST /internal/telegram-forward`: after the existing lifeline-secret gate, a `topicName` is recorded with `TelegramAdapter.captureTopicName` only when the sender is lifeline-trusted and the request is not a mobile one. A name-only forward is acknowledged (`{ ok: true, nameOnly: true }`) and goes no further; an empty text without `nameOnly` is still a 400.
3. `TelegramAdapter.captureTopicName(topicId, name, isEdit)`: the poller's existing capture logic, extracted so both paths share it. A creation name never overwrites a known name; a rename does and fires the existing rename handler. Names are trimmed and capped at 128 characters.

## Evidence
On 2026-11-02, five sessions on Mama PC showed as "Conversation name unavailable" on the dashboard. Four were topics the operator created in Telegram that day (135187, 135556, 135758, 135786); neither the Studio (which polls through its lifeline) nor Mama PC had their names, and the Studio's message log had their messages. The lifeline's `processUpdate` returned early on any update without text.

## 1. Over-block
None.

## 2. Under-block
A topic created while the server is down: the name-only forward is skipped, and the name arrives with the topic's next message (which carries the creation message). A topic whose messages never reach this machine stays unnamed here, as before.

## 3. Level-of-abstraction fit
The lifeline is the only component that sees the update; the adapter owns the name registry. Correct layers.

## 4. Signal vs authority
Display data only. The name is accepted only from a lifeline-proven sender (the same gate that decides sender identity), so a session cannot rename topics shown to the operator.

## 5. Interactions
The name-only forward returns before pairing-invite handling, message logging, sessions and the sentinel, so it can never be treated as a message. Older servers answer 400 to the name-only forward (empty text); the lifeline ignores the result. Older lifelines omit the fields; nothing changes.

## 6. External surfaces
Topic names appear on the dashboard and in alerts instead of "Conversation name unavailable" or numbers.

## 7. Multi-machine posture
The name is recorded on the machine whose lifeline polls (the lease holder). Other machines read it through the pooled topic list.

## 8. Rollback cost
Revert the commit. Names already recorded stay, which is harmless.

## Class closure
unbounded-self-action: n/a. One best-effort forward per topic service message received; no retry loop.

## Follow-up
The two rename-handler catches moved into `captureTopicName` carry `@silent-fallback-ok` (the no-silent-fallbacks ratchet reads 20 lines after each catch, and in the new position those lines include fallback wording from the next function). `session-lifecycle-phase-3-wiring` pins the new source shape.
