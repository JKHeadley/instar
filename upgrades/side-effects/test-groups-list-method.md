# Side effects: list Telegram test groups with contacts.search

## What changed
`TelegramWebKDriver.listTestGroups` asks Telegram's chat search (`contacts.search`, q "Instar test", limit 100) instead of `messages.getAllChats`. The same filter applies (creator, megagroup, forum, marker title). The read is incomplete when the account's own matches fill the page (100).

## Why
Live on the Studio, 2026-11-09 13:21 PST, with the error detail from #2990/#2996: `{"kind":"Error","message":"No method messages.getAllChats found"}`. Web K ships only the API methods its own interface calls; `getAllChats` is not one, `contacts.search` is (the search box). The other test-group calls (createChannel, inviteToChannel, editAdmin, getParticipants, getChannels, deleteChannel) are all actions the Web K interface itself performs.

## Review
1. Over-block: a test group whose title Telegram's search does not match would be missed; titles are fixed ("Instar test - ... [itg-...]"), so search by the prefix finds them.
2. Under-block: delete still verifies the marker before deleting; an operator chat is never returned by the search, so it reads "not present" and can never be targeted (it answers "gone" instead of "not-a-test-group": a label change, never a deletion).
3. Level: the page script, the only place the API is called.
4. Signal vs authority: unchanged.
5. Interactions: `requested.present` now means present among title matches.
6. External surfaces: one different read-only API call on the operator's Telegram.
7. Multi-machine: unchanged.
8. Rollback: revert.

## 6b. Operator-surface quality
Not an operator surface.
