# Telegram delivery robustness — plain-English overview

Instar already keeps temporarily failed Telegram replies in a local recovery
database and retries them later. This change tightens two promises around that
existing system.

First, the relay says “Queued for recovery” only after reopening the canonical
database and finding the exact attempted message: its delivery ID, topic, text
hash, and queued state must all match. If that proof fails, the relay reports
the failure honestly instead of claiming the message is safe.

Second, recovery workers use one renewable ownership claim per delivery ID.
Only the worker holding the exact current claim can finish or release the row,
so overlapping workers cannot both send the same recovered reply. Old empty
database files at obsolete paths are atomically renamed into quarantine and
never automatically deleted, preserving any bytes written during a race.

No new queue or delivery route is introduced. The canonical path, existing
SQLite schema, Telegram send funnel, tone gate, and server-side delivery-ID
deduplication remain the authorities. The technical spec is the detailed
reference for retry policy and lifecycle behavior.
