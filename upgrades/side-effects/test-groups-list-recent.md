# Side effects: test-group list also reads the newest 100 chats

## What changed
`listTestGroups` merges `messages.getDialogs` (newest 100 chats, the Web K chat list call) with the `contacts.search` result, by chat id, before the same candidate filter.

## Why
Live proof on the Studio, 2026-11-09 14:57 PST: a test group created one minute earlier ("Instar test - proof [itg-agc2kuossx]", confirmed to exist through the test bot's getChat) was not returned by `contacts.search`, so the list missed it and delete answered "gone" without deleting.

## Review
1. Over-block: none. 2. Under-block: a test group older than the newest 100 chats and not indexed by search would be missed; search covers older ones.
3. Level: page script. 4. Signal vs authority: unchanged; delete still verifies the marker.
5. Interactions: `requested.present` again reports chats that exist (from the chat list), so delete of an operator chat answers not-a-test-group, as originally designed.
6. External surfaces: one more read-only call on the operator's Telegram per list. 7. Multi-machine: unchanged. 8. Rollback: revert.

## 6b. Operator-surface quality
Not an operator surface.
