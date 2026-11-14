# Telegram Origin Store Stall, in plain words

Before Instar sends a Telegram message, it writes the message down in a small database, so that nothing goes out unrecorded and nothing gets sent twice. On 2026-11-05 Justin's replies waited over 20 minutes. Four separate things were wrong, and the network was not one of them.

**A checking job blocked the database.** A job added the day before looks for replies that arrived late or out of order. It compared each recent reply against every delivery receipt ever kept, about 2,000 times 66,000. On a copy of the real database one run took 39 seconds. The database does one thing at a time, so every reply waited behind it and gave up after 2 seconds. After 30 seconds a safety timer killed the worker, and 5 minutes later the job started again. It now reads one page in order and compares each reply only with replies written around the same time. A page now takes under a tenth of a second (the first, cold one 0.4 seconds), and the answers matched the old job on all 1,117 real rows.

**A connection timer was too short.** Node tries each address of a server for 250 ms. Telegram's address takes about 170 ms to answer here, and this machine has no route to the second one. If the server paused for an instant at the wrong moment, the timer ran out even though the connection had succeeded. We reproduced this in a test. The timer is now 5 seconds.

**One slow settings read stopped all sending.** Instar re-reads its settings every 5 seconds. If a read took longer than 2 seconds, every send was refused until the next read worked, which happened 46 times in 3 hours. A slow read says nothing about whether the settings changed. Now it gets 10 seconds, and if it still runs out of time the last good copy stays usable for its normal 30 seconds. A real problem, such as a broken file or a changed token, still stops sending at once.

**Retries waited too long.** A refused reply was due again in 30 seconds, but recovery only ran every 5 minutes, and each message could only start recovery once per 15 minutes. One bad moment could cost 24 minutes. Sometimes the reply was then dropped because the conversation had moved on. Recovery now runs every 30 seconds, and the waits go 30 seconds, 1 minute, 2 minutes, 5 minutes, then 15 minutes.

**What keeps this safe.** No new way of sending was added. A message whose delivery is uncertain still never retries by itself, and a test checks that at every step. Notices to the reader about late replies keep their old pace. Undoing this is a plain revert.

**What you need to decide.** Nothing. Whether the 2-second settings reads come from inside the server was not measured, because that would have meant touching the live server, so this fixes what a slow read is allowed to do rather than why it is slow.
