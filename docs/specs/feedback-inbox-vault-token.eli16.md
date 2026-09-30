# Feedback inbox reads its Blob token from the vault — Plain-English Overview

> The one-line version: the feedback mover on the Mac Studio now finds its password in the agent's own locked safe instead of waiting for one that could never arrive, and the job that checks on it can now actually say "this failed".

## The problem in one breath

Other agents send their bug reports to a cloud mailbox. A small mover on the Mac Studio is supposed to empty that mailbox into the agent's local store. The mover needs a password (a "Blob token") to open the mailbox. The code only looked for that password in an environment variable, but the server is started inside a tmux session whose environment was fixed long before, so on the Mac Studio that variable never reached it. So the mover never started, for weeks. (A second, separate setting was also missing: which machine owns the drain. That was set on 2026-09-29 and takes effect at the next restart.) At the same time, the half-hourly job that is meant to notice this kept writing "success", because a job like this had no way to record a failure at all.

## What already exists

- **The encrypted vault** — every agent keeps its secrets in an encrypted file. The password for the mailbox is already stored there under the name `feedback_inbox_blob_token`. Scripts already read from it the same way.
- **The mover (InboxDrainer)** — works; it just never got switched on because it never saw the password.
- **The drain status page** — already tells the truth: it said "unavailable" the whole time.
- **The scheduler's failure alert** — after three failed runs in a row it tells the operator. It never fired here because nothing ever counted as failed.

## What this adds

The main change: when the environment variable is empty, the server looks the password up in the vault. If the environment variable is set, it still wins, so nothing changes for anyone who relied on it. The server logs only *where* the password came from ("env" or "vault"), never the password itself. If neither place has it, the mover stays off exactly as before. Because the vault is copied to all of the agent's machines, the mover now also checks that this machine is the one that owns the drain; every other machine leaves it off, so reports are never split between machines.

Secondary changes:

- A scheduled job can now mark its own run as failed by writing a short note into a file the scheduler names for that one run. When the run ends the scheduler reads the note, records the run as failed with the note as the reason, and deletes the file.
- The server itself also raises a warning when the drain on the development agent is unavailable, so the check no longer depends only on the job's model reading its instructions correctly.
- The feedback drain job uses this: if the status page says the drain is unavailable (or, on the development agent, the page cannot be read), the run is now recorded as failed with the reason. Three in a row reach the operator through the existing alert. A drain an operator deliberately switched off stays quiet.
- The agent's instruction file now says the password can come from the vault, and tells agents how a job declares failure. Existing agents get these text updates on their next update.

## The safeguards

**The password never leaks.** It is not printed, logged, sent over the API or written anywhere new. Tests check the logs for it.

**No false failures.** Each run gets its own note file, named after that run's session, so a note can only ever fail the run that wrote it. Notes are cleaned of anything that looks like a password before they are stored or sent in an alert.

**Nothing new turns on by itself.** The mover still only runs when an operator has switched the receiving end on in config. Only jobs that write the note can fail this way.

## What ships when

Everything ships in one release: the vault lookup, the failure note, the updated drain job, and the updated instruction text. Rolling back is a normal release revert.
