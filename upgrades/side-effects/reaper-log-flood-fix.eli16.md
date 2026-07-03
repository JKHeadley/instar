# Reaper log-flood fix — Plain-English Overview

> The one-line version: the reaper was scribbling the same "couldn't clean this up" note into an audit file thousands of times a minute until the file grew to 142MB and froze the whole server when anything read it — this makes it write the note once and read the file in small bites.

## The problem in one breath

Every agent has a background "reaper" that tidies up finished sessions. When a session CAN'T be tidied yet (it has an open promise to the user, or it belongs to another machine), the reaper politely skips it — and writes a one-line "skipped, here's why" note to an audit log. The bug: it re-checks and re-writes that identical note on every single tick, forever. On a live agent that piled up 3,218 + 1,608 duplicate notes and grew the log to 142MB. Worse, the code that READS that log loaded the entire 142MB into memory at once, which pegged a CPU and froze the server for ~90 seconds each time.

## What already exists

- **The reaper** — the background tidier that decides which sessions to close. Its actual close/keep decisions are correct and are NOT changed by this work.
- **`reap-log.jsonl`** — the "why did my session vanish?" audit trail. One line per close, one line per refused close. This is the file that ballooned.
- **`reaper-audit.jsonl`** — a SEPARATE, sibling audit file that already does the right thing: it only writes when a decision CHANGES, not on every tick. It stayed tiny (under half a megabyte). We copy its proven habit.

## What this adds

The reaper's skip-note now follows the same "only write when something changed" rule its sibling already uses. If a session is skipped for the exact same reason as last time, no new note is written. The moment the reason changes — the promise closes, the session moves machines, or it finally gets reaped — a fresh note is written, so the audit trail still tells the true story with none of the spam.

Two more safety belts:

- **Small-bite reading** — reading the log now pulls only the last couple of megabytes off the end of the file instead of the whole thing, so even a giant log can never freeze the server again.
- **Auto-rotation** — if the file ever crosses 16MB anyway, it's instantly rolled aside to a single backup and a fresh file is started, so it can never grow without bound. Reading transparently stitches the backup back in so recent history is never lost.

## The new pieces

- **Transition dedup (in-memory)** — a tiny table remembering each session's last-written skip reason. It's per-machine, capped at 2,000 entries (sessions are only ever a few dozen in practice), and forgotten the instant a session is reaped so it can't leak. It is NOT allowed to change any close/keep decision — it only decides whether a LOG LINE is worth writing.
- **Bounded tail reader** — reads the end of the file only. It carefully drops a half-a-line at the read boundary so a torn record is never mis-parsed.
- **Size-cap rotation** — an instant rename (no slow file rewrite) when the file gets too big.

## The safeguards

- The reaper's real authority — which sessions live or die — is untouched. This is purely about how much it writes and how the file is read.
- Nothing is lost from the audit story: first-skip, every change-of-reason, and every actual reap are all still recorded. Only the identical-to-last-time repeats are dropped.
- It's per-machine by design (each machine audits its own reaping), matching the sibling file. No cross-machine syncing to get wrong.
- Rollback is a one-file revert with no data migration — old fat logs and new backups both read correctly through the new reader.

## What you need to decide

Nothing structural — this is a contained, low-risk hygiene fix with full unit-test coverage (16 focused tests; 115 reaper-family tests green). The one judgment call baked in: we accept losing the per-tick "still skipped at 12:00:01, still skipped at 12:00:02…" heartbeat in exchange for a log that doesn't self-destruct. That trade matches what the sibling audit file already chose, so it's a consistent, already-proven decision rather than a new gamble.
