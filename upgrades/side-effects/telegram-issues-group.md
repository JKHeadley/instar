# Side-Effects Review — Telegram issues group ("<agent> Bugs")

**Version / slug:** `telegram-issues-group`
**Date:** `2026-10-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

An optional second Telegram forum group per agent for issue topics. New module
`src/messaging/telegramTopicSpace.ts` maps an issues-group thread to an internal topic id
`10_000_000_000 + thread` and back. Translation points: `TelegramAdapter.apiCall`,
`TelegramLifeline.apiCall`, `TelegramOriginService.prepareBot` (new `wireParams` option,
fed from the origin boot's live config snapshot), and inbound normalization in the adapter
(`processUpdate`, `processCallbackQuery`) and lifeline (`processUpdate`). Prompt-gate edits
carry the chat they were sent to. `createForumTopic`/`findOrCreateForumTopic` gain
`space: 'issues'`. `POST /telegram/topics` accepts `kind: "issue"` and returns `group`.
Origin `authorize` admits the configured issues chat. `importLegacyQueue` prepares each row
in its own try. CLAUDE.md template + migration gain one awareness paragraph.
New config field: `messaging[telegram].config.issuesChatId` (absent = off).

## Decision-point inventory

- Origin `authorize` (TelegramOriginBoot) — modify — admits one more destination chat, the agent's own `issuesChatId`.
- `toWireParams` — add — refuses an issues-range topic id when no issues chat is configured (structural; the caller gets an `issues-chat-not-configured` error; nothing is sent or recorded).

---

## 1. Over-block

The only new refusal is an issues-range topic id (> 10^10) on a process with no
`issuesChatId`. Such ids are created only by this feature, so a legitimate send can hit it
only when config was removed or differs between machines; it is then refused with a
named error (not queued for retry), never sent to the wrong group. No other input is newly rejected.

## 2. Under-block

- Two machines configured with DIFFERENT issues groups resolve the same id to different
  chats. Not detected; documented as a config rule (same as `chatId`).
- With `issuesChatId` unset and the bot still in an issues group, inbound messages there are
  filed as main-group topics, exactly as they would be today (pre-existing behaviour for
  any extra group the bot is in). Rollback note says to remove the bot from the group.

## 3. Level-of-abstraction fit

Translation sits only at the Telegram edges (the two `apiCall`s and the origin sealing
point), which are the existing funnels for Bot API requests. Everything above keeps one
topic number. A composite `(chat, thread)` key would have touched every layer.

## 4. Signal vs authority compliance

No brittle check gains blocking authority. The authorize change widens an allow-list by
one operator-configured value (deterministic equality). The `toWireParams` refusal is a
routing fact (no destination exists), not a judgment about content.

## 4b. Judgment-point check

No competing-signals decision point added.

## 5. Interactions

- Origin recording: sends are sealed after translation, so lease-holder forwarding,
  held-reply notices, mesh relay and recovery replay all carry the issues chat and real
  thread. Idempotence means adapter-translated params pass through `prepareBot` unchanged.
- Origin display: per-conversation display overrides are looked up by the internal id for
  issues-chat sends.
- Topic-creation flood budget applies unchanged to issue topics.
- Legacy-queue import: one row that cannot be prepared no longer aborts the import loop.

## 6. External surfaces

- New optional config field; new optional request field `kind` and response field `group`
  on `POST /telegram/topics` (additive).
- Agents see larger topic ids (11 digits) for issue topics; validators accept them
  (relay script uses `int()`, route uses `parseInt`, profile key regex allows 16 digits).

## 7. Multi-machine posture

Machine-local config, like `chatId`: each machine reads its own `issuesChatId`; the value
must be the same on every machine of one agent. Topic ids already replicate. A machine
without the field refuses issues-range sends with a named error instead of misrouting them; sealed requests
forwarded to the lease holder are already translated.

## 8. Rollback cost

Config: remove `issuesChatId` and remove the bot from the group; sends to issue topics are
then refused with a named error, never misrouted. Code: normal revert release; after revert an issues-range send
goes to the main chat with an unknown thread id and Telegram rejects it. No data migration.

## Conclusion

Additive, opt-in, translation confined to the existing Telegram funnels. Ship.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent
**Independent read of the artifact:** concern raised, then resolved. The reviewer found §1/§7/§8 said an issues-range send without `issuesChatId` is "held (recoverable)"; it is actually refused with a thrown `issues-chat-not-configured` error before any recording. Nothing is misrouted. The artifact and spec now say "refused". The reviewer confirmed the rest: main-group behaviour unchanged when unset (prompt-gate edits and the probe delete now take the chat id from Telegram's reply: the same chat, as a number instead of the config string), both inbound paths normalize, outbound passes both apiCalls and the origin seal idempotently, authorize adds one exact-equality match and fails closed, no brittle check gains authority.

## Evidence pointers

- `tests/unit/telegramTopicSpace.test.ts`
- `tests/unit/TelegramAdapter-issuesGroup.test.ts`
- `tests/unit/telegram-origin/origin-service.test.ts` (issues-group sealing case)
- `tests/unit/telegram-issues-group-wiring.test.ts`
- `tests/integration/telegram-issue-topics-route.test.ts`
