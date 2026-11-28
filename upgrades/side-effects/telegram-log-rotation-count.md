# Telegram log rotation count side effects

## Decision and authority

No authority changes. TelegramAdapter.maybeRotateLog keeps its rule: above 20 MB, rotate to the last 75,000 non-empty lines when there are more than 100,000. Only how it knows the line count changes: an in-memory count of newline bytes, built once and then advanced by reading only the bytes appended since the last check. A smaller file than at the last count, or a different inode (the log replaced by another writer), resets the count. When the newline count reaches 100,000 (N newlines can mean N+1 lines when the last line has no newline) the whole log is read as before and decides exactly, and the exact non-empty count from that read replaces the newline count, with the byte position taken from the bytes read rather than the decoded text, so blank lines cannot cause a full read on every later append.

## Data and resource effects

No data or format changes. Per append on a large log: one stat plus a read of the appended bytes, instead of reading, decoding and splitting the whole file. The first check after start counts newlines across the whole file once (raw bytes, no decode or parse). Another process appending to the same log is covered, because the count follows the file size, not this process's own writes. On any error the count is dropped and rebuilt on the next check, as rotation errors were already non-critical.

## Rollback and verification

Revert the function and the two fields. Verification: tests/unit/telegram-log-rotation-count.test.ts covers repeated appends to a 22 MB log with no whole-file read, rotation of a 100,500-line log to 75,000, and a later check that reads only the appended bytes.

## Review

First part of the topic-history stall fix (CMT-049), split out because it relieves every logged message (Chief of Staff, 2026-11-27).

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author (Parity session, 2026-11-27 04:08-04:10 PT)

Verdict CONCUR WITH CHANGES. Required and applied: the second test's lines made the rotated log fall under 20 MB, so its chunk-read assertion could not hold (now 300-byte lines); the gate was off by one against the old non-empty-line rule (now N >= 100,000 triggers the exact read); the post-read byte position used the decoded length (now the raw byte length); a replaced log of larger size went unnoticed (now the inode resets the count). Confirmed: the only caller is the legacy append path; the shared MessageLogger rotates by itself and never calls this; spies see the adapter's fs calls; the constructor does not read the log; seedMessageLogDedupe reads the whole log once per process only.

## 6b. Operator-surface quality

No visible surface changes.

## Framework generality

Telegram adapter internals only. Nothing depends on an agent framework or model provider.
