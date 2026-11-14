# A notebook that never threw pages away — Plain-English Overview

> The one-line version: the agent kept a note for every working session it ever started and re-read the whole pile many times a minute; it now throws away the notes that are too old to be used.

## The problem in one breath

When a session of the agent is restarted, it helps to tell it "before the restart you were working in this folder". To do that the server keeps a small note per session: where it started and where it is working now. A note older than six hours is never used, by design: after that long the information is considered stale.

Nothing ever removed the old notes. Every scheduled job starts a short session, and there are hundreds a day, so the pile only grew. On the maintainer's machine it had reached 32,378 notes in one 8-megabyte file, and all but 90 of them were too old to ever be used.

The server reads that whole file for each running session every time it checks on its sessions, and rewrites the whole file every time a new session starts. Reading and decoding 8 megabytes over and over was the single largest steady cost on the server's main thread that morning, the same thread that has to answer messages and health checks.

## What already exists

- **The note store** — one file, one note per session, written when a session's working folder changes.
- **The six-hour rule** — a note older than that is ignored when a session restarts.

## What this adds

Whenever the store is written, notes older than six hours are left out. That is the whole change. Reading is untouched, and a session whose folder has not changed still causes no write at all.

## The safeguards

**Only useless notes go.** The rule for dropping a note is exactly the rule that already made it unusable. A note at exactly six hours is still usable and is kept; a test pins that edge.

**One behaviour does change, on purpose.** A session that has stayed in the same folder for more than six hours used to keep a note that was too old to use, so a restart did not remind it where it was. Now its old note is dropped and, on the server's next check, a fresh one is written. A restart will then remind it of the folder it is in. A test pins this so it is a decision and not an accident.

**Proved on a big pile.** A test builds a store with 5,000 expired notes and one live one, starts one new session, and checks that exactly the two live notes remain.

## What it costs

Nothing. The store gets smaller and faster.

## What you need to decide

Nothing. This is a narrow repair with no setting; undoing it is a plain revert. On the maintainer's machine the file was also pruned by hand at 8:04 AM, so the relief there did not wait for this change.
