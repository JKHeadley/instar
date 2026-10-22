## What Changed

- **Issue topics can live in their own Telegram group.** A new optional setting, `issuesChatId` in the Telegram messaging config, names a second forum group (for example "Echo Bugs"). `POST /telegram/topics` with `"kind":"issue"` creates the topic there and answers `"group":"issues"`; without the setting it uses the main group as before. Inside Instar these topics have ids of 10,000,000,000 plus Telegram's thread number, translated only where Instar talks to Telegram, so sessions, the reply script and reminders work unchanged. Sends, the lifeline's notices, cross-machine forwarded replies and prompt-gate edits all reach the right group.

## What to Tell Your User

Bug and problem topics I open while working can now go into their own Telegram group, so they stop crowding your main topic list. I set the group up myself from your signed-in Telegram; you don't need to do anything.

## Summary of New Capabilities

- Optional "<agent> Bugs" Telegram group for issue topics (`issuesChatId`, `POST /telegram/topics` with `"kind":"issue"`).

## Evidence

- `tests/unit/telegramTopicSpace.test.ts`, `tests/unit/TelegramAdapter-issuesGroup.test.ts`, `tests/unit/telegram-issues-group-wiring.test.ts`, `tests/unit/telegram-origin/origin-service.test.ts`, `tests/integration/telegram-issue-topics-route.test.ts`
