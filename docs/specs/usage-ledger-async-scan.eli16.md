# The usage scan stops holding up the server — Plain-English Overview

> The one-line version: once a minute the server looked through every saved conversation file on the machine to count usage, and it did all of that looking on its one main thread; now the looking happens in the background.

## The problem in one breath

The server does everything on one main thread. To keep its record of how much each account and model has been used, it checks once a minute which conversation files have grown. On a development machine with a dozen sign-ins that means opening about 4,000 folders and checking about 50,000 files, one after another, with the server able to do nothing else until it is finished. Measured on the Studio on a quiet disk, that is 0.7 to 1.9 seconds every minute. On 2026-11-13 at 2:36 AM, with the disk busy under a test run, it took over a minute. The server stopped answering, and its supervisor killed it, together with the test run in progress.

## What already exists

- **The usage ledger** — a small database of how many tokens each request used, built by reading the conversation files that Claude Code and Codex write.
- **Checkpoints** — for each file, how far the ledger has already read, so an unchanged file costs nothing to process.
- **A budget** — at most 500 changed files are read in one tick, so the reading itself is bounded.
- **The listing** — the step before all of that: walking every folder to find which files exist and which have changed. This is the part that had no bound and ran on the main thread.

## What this adds

The listing now runs through the operating system's background file workers. The main thread asks for a folder or a file's details and gets on with other work until the answer comes back.

## The new pieces

- **A background version of the minute tick** — the same walk, the same rules about which folders and files count, the same result. Only where the waiting happens changes.
- **One tick at a time** — if a tick is still listing when the next minute comes round, the new one is skipped. If five in a row are skipped, the server says so in its log, so a listing that never ends cannot quietly stop the usage record.
- **The hourly cleanup, too** — once an hour the ledger checks whether each remembered file still exists (tens of thousands of checks). That also moved to the background.

## The safeguards

**Same answer as before.** Tests run the old and the new version over the same folders (two sign-ins, a subagent file, a folder that belongs to someone else, a file that is too deep, a linked file, a file that is too old, a Codex file) and require identical counts and reports. On the Studio's real folders both found the same 34,059 files.

**Proven not to block.** A test fails if the new tick makes even one blocking folder read or file check while listing. On the Studio's real folders the main thread was never held more than about 20 ms, against 0.7 to 1.9 seconds before.

**Closing down is safe.** If the server shuts down while a tick is listing, the tick ends quietly and reads nothing.

**The old version is still there** for tests and tools that want an immediate answer. The server no longer uses it.

## What is not fixed by this

Only the looking moved. Reading the changed files themselves (up to 500 a tick) still happens on the main thread, as does writing the hourly summary copy. Normally only a few dozen files change in a minute and that is quick. Right after the usage database is reset, or a new sign-in is added, there can be hundreds of whole files to read for a few minutes, and after the usage record is restored from a backup every file is read once more from the start. On a very busy disk either of those could still hold the server up long enough to get it restarted. Neither was what the freeze capture showed. Other causes of the server being killed under load are tracked under the same commitment (CMT-1718).

## What you actually need to decide

Nothing. This is a small, reversible change: no stored data or setting changes, and a revert restores the old behaviour.
