# Commitment detection message source

Six Wintest reports covering 1.3.1939 through 1.3.1943 described a missing Telegram log and a job bookmark stuck at zero. Commitment detection needs the recent local Telegram conversation even when the flat log is absent or stops receiving new rows.

## Source selection

TelegramAdapter.appendToLog writes the log before invoking the SQLite dual-write callback. A failed callback can leave a message only in JSONL. The log and the live SQLite writer record user, agent, and automation provenance. Existing SQLite rows remain unclassified. TopicMemory can receive carried Telegram rows through the topic row writer. A readable log alone therefore cannot establish that the detector has seen the current conversation.

The shared reader consults the open TopicMemory store and the bounded Telegram log tail. SQLite selects positive Telegram topic and message IDs and excludes recovered rows marked `imported`. Historical restoration must never register a fresh action. When both sources are available, combine their capped windows by topic and message ID, use the logged row on overlap, then take the highest message IDs up to the limit. A closed or absent store can use a readable legacy tail. A missing log can use SQLite. A failed source read is reported. Only a successful read with no eligible rows is idle.

## Consumers and progress

The installed five-minute job requests up to 100 recent messages through the authenticated local `GET /telegram/search?recent=1&limit=100` route. It filters by the existing integer `lastProcessedId`. The job examines the whole batch and registers each action with a deadline or an explicit follow-through opt-out. After successful processing, including a batch with zero commitments, the helper atomically advances the bookmark. An equal or older acknowledgement produces no write or effect receipt.

The sentinel applies its independent per-topic marks before limiting each source to ten times the configured batch size. Its existing pairing logic consumes the oldest selected messages first and skips replies labelled as automation. Both consumers read locally across topics, including topics without active sessions.

## Installation and acceptance

Init and the shipped job template invoke the same helper. Updates refresh the built-in helper and replace either recognized stock legacy prompt. Prompt matching normalizes line endings and the configured port. Customized prompts retain their text. The stock prompt repair preserves scheduling and enablement.

Unit fixtures exercise absent and stale logs, duplicate rows, recovered history, provenance, and resumed scans. An installation fixture applies the built-in installer and legacy prompt repair twice, then executes the installed bookmark helper. The parent owns the private loopback HTTP checks for authenticated reads, the 100-row window, idle responses, source failure, and legacy fallback.
