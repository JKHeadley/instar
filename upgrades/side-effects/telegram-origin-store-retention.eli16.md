# Telegram origin store retention — plain-English overview

Every Telegram message an agent sends is first written to a local database. On the Studio that file reached 644 MB, and a once-a-minute cleanup spent 3 to 9 seconds searching it. The database does one thing at a time, so replies arriving during the search waited too long and were held.

This change makes the search use a saved position, so it takes milliseconds. It also adds limits. Old message detail moves to archive files after seven days, a small searchable record stays behind, count records are folded into totals, and history older than a year is removed by default.

The cleanup does a little each minute and slows down on a busy disk. A message is only removed after its archive copy is safely written, unfinished messages are never touched, and an old message cannot be sent twice because of the tidy-up.

The file stays at 644 MB and stops growing. Shrinking it took 37 seconds in testing, and replies would be held that whole time, so that is left as a separate choice.

The full overview is in `docs/specs/telegram-origin-store-retention.eli16.md`.
