# Track completed Telegram polling catch-up

This dormant SQLite state tracks one catch-up poll at a time. Empty results only open the exact current generation and cursor. Nonempty results and explicit closure invalidate earlier attempts. A stale result cannot reopen them.

- Authority. The caller must establish the serving bot, poll writer and authenticated result. No production caller or send path reads this table.
- Ordering. Writes refuse caller-owned transactions. Before activation, the actual poller must establish one current writer and the reservation must check coverage in the same transaction.
- Data and rollback. Stores only a random generation, cursor and drained state in the disposable test. No production migration.

Independent review concurred. Future activation must close persisted coverage at startup before admitting reservations.
