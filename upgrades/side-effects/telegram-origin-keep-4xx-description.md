# Side effects: Telegram 4xx refusals are logged with their description and request shape

**Version / slug:** `telegram-origin-keep-4xx-description`
**Date:** `2026-11-27`
**Author:** `Echo (Telegram Parity)`

## Decision and authority

No authority changes. In TelegramOriginService's 4xx branch (the known-failed path, including 429), one `console.warn` line is added before the existing edit-rejection record and throw. Two new exported helpers build it: `describeTelegramRefusal(description)` (Telegram's description string, flattened to one line, bounded to 160 characters, bot-token shapes redacted; `no description` when absent) and `describeRequestShape(body)` (sorted parameter names; `text` and `caption` as their length; `entities` and `caption_entities` as type@offset+length, at most 20; numbers and booleans as values; a string value printed only for an allowlist of id and mode keys (`chat_id`, `from_chat_id`, `message_thread_id`, `direct_messages_topic_id`, `message_id`, `message_ids`, `inline_message_id`, `parse_mode`, `business_connection_id`, `message_effect_id`) and only when it matches `^[A-Za-z0-9_@:.-]{1,40}$`, every other string as `<string:N>`; top-level key names cleaned to lowercase letters and underscores, at most 32 characters; a non-object entity shown as `<invalid>`; `reply_parameters` and `link_preview_options` one level deep, numbers and booleans only; any other object or array named by type; whole shape bounded to 600 characters). The recorded outcome, its reason (`telegram-<status>`), retry scheduling for 429, the hold error and the edit-rejection record are unchanged.

## Data and resource effects

One log line per refused send in logs/server.log. It never contains message or caption text, button text or URLs; it does contain chat id, thread id and reply message id, which the log already carries elsewhere. Telegram's description is Telegram's own API wording; for a formatting refusal it can name a tag or entity type, bounded to 160 characters. A 429 storm writes one line per refused attempt, which the existing retry pacing bounds.

## Rollback and verification

Revert the commit: the log line and the two helpers disappear. Files: src/messaging/telegram-origin/TelegramOriginService.ts, tests/unit/telegram-origin/origin-service.test.ts. Verification: tests/unit/telegram-origin/origin-service.test.ts (log line for a refused 400 with the description kept and the token blanked; description bounding; request shape with text, entities, reply parameters and link preview options, and no private text), plus the existing 429 test.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 16:23 PT, read only. Verdict: CONCUR WITH CHANGES.

It confirmed the line fires only in the 4xx known-failed branch, once per refused attempt, after the outcome is recorded, with the outcome, 429 scheduling, hold error and edit-rejection record unchanged; reply quotes, link preview URLs, button text and entity URLs never reach the log; and the ratchets pass. Applied its three fixes: string values print only for an allowlist of id and mode keys (a safe-shaped word under another key, such as an audio title, showed as written before); top-level key names are cleaned so a caller key cannot inject text or newlines; a null or non-object entity no longer throws. Added tests for each, and for a 429 logging one line.

## 6b. Operator-surface quality

No visible surface changes.

## Framework generality

Telegram origin service internals. Nothing depends on an agent framework or model provider.
