# Telegram message log rotation check no longer rereads the log

## What Changed

Every time a Telegram message was written to the message log, a log over 20 MB was read whole, split into lines and counted to decide whether to rotate it, but rotation happens only above 100,000 lines. A 30 MB log with fewer lines therefore paid a full synchronous read on every logged message, blocking the server each time; the Studio's log is about 33 MB. The check now counts the log's lines once by counting newline bytes, then counts only the bytes added since the last check. A log that shrank (rotated elsewhere) is counted again. Rotation itself is unchanged and still keeps the last 75,000 lines.

## What to Tell Your User

A machine with a large Telegram history no longer slows down every time a message is logged.

## Summary of New Capabilities

No new capability. One fix: the rotation check reads only what was appended.

## Evidence

Reproduction: on main, TelegramAdapter.maybeRotateLog calls readFileSync on the whole log after every legacy append once the file passes 20 MB; the Laptop CPU profile of 2026-11-27 shows readFileSync at 23 percent of self-time. Before: five appends to a 22 MB, 20,000-line log meant five whole-file reads. After: tests/unit/telegram-log-rotation-count.test.ts shows those five appends make no whole-file read, a 100,500-line log still rotates to 75,000 lines, and a later check reads only the appended bytes in one chunk.
