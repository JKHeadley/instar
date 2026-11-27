# Usage ledger transcript ingestion

## Scope

Move transcript reads, decoding and parsing for the scheduled scan into one local worker per scan. Return only the fields used for usage accounting. Keep existing usage attribution, pairing, public routes, persisted schema and file ownership.

## Runtime effects

- A normal file receives up to 64 batches or 250 milliseconds between batches per tick. Ordinary reads are 256 KiB and each transaction applies up to 128 relevant records. An oversized line can take longer to locate and parse in the worker.
- A partial or failed read leaves the checkpoint at the last committed complete line. A retry uses the stored inode, head digest, offset and Codex cumulative token state. Rows, rollup changes and the checkpoint still advance together.
- The worker reads local transcript files and makes no network calls. The scanner keeps one worker and one pending read at a time. An unresponsive read is cancelled. The worker terminates when the scan ends or the ledger closes.
- Snapshot detail replay uses the same bounded batches after normal ingestion. It stays within the checkpointed extent and verifies the transcript generation before reading. The hourly housekeeping decisions and synchronous administrative scan remain available.
- Studio incident timestamps show overlap with this scanner. The captures do not identify its callbacks as the source of the two stalls.

A rollback restores the original reader. Both implementations consume the same newline-aligned checkpoint format, so existing and partially processed ledgers remain readable.

## Review

The existing file membership and file-age rules still decide which records count. A missing, replaced, or unreadable input follows the existing pending and retry behavior. One very large completed line still takes time and memory in the worker. The main thread retains SQLite transactions, which can still wait on the database under disk pressure. The existing usage scan and checkpoint store are the right layer for those constraints. As described in `docs/signal-vs-authority.md`, this accounting pipeline supplies observations. It grants no new action, admission or session-movement authority.

The one-scan guard continues to serialize ticks, and the apply step checks that the ledger is open after each worker response. Changes appear in the existing coverage fields as a backlog that can span multiple ticks. Transcript reads and checkpoints stay local to the machine that owns those files. Existing usage pool replication shares only the ledger's established rollup and binding rows.
