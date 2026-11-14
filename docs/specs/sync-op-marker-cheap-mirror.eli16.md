# The server's "busy" note is written once per burst, not twice per check — Plain-English Overview

> The one-line version: the server stops writing a small file to disk twice for every session check, which was costing more than the checks themselves and helping the server freeze under load.

## The problem in one breath

The server runs on one main thread. While that thread waits on a helper program (for example asking tmux whether a session is alive), it can do nothing else. A separate supervisor watches the server and restarts it if it stops answering for about a minute. So that the supervisor can tell "busy waiting on a helper" from "really stuck", the server writes a small "busy" note to disk before each such wait and a "not busy" note after it. On 2026-11-13 a profile of a loaded server showed those notes took about 11% of everything the server did, against about 2% for the helper programs they describe. That night the supervisor killed the server four times for not answering, and each kill also killed a test run in progress.

## What already exists

- **The busy note** — one small file, read by the supervisor (a different process) and by the server's own wake-from-sleep handler.
- **A freshness limit** — a note older than 18 seconds is treated as stale and ignored, so a note left behind can never keep a stuck server alive for long.
- **The in-memory flag** — the server's own sleep detection reads memory, not the file, and is not changed here.

## What this adds

The note is written when its answer would change, not on every wait. A burst of fifty checks in one go costs one "busy" write at the start and one "not busy" write once the server's main thread is free again, where it used to cost a hundred.

## The new pieces

- **Write on the first wait of a burst only** — later waits in the same burst reuse the note already on disk. A long burst refreshes the note's time stamp once it is a quarter of the freshness limit old, so it never goes stale while waits keep starting.
- **"Not busy" is written when the thread is free** — queued for the end of the current turn of the server's loop instead of after each wait.
- **The server settles the note before reading its own copy** — its wake-from-sleep handler flushes the pending "not busy" write first, so it never mistakes a finished wait for one in progress.

## The safeguards

- The "busy" write still happens before the wait starts, so the supervisor can never see "not busy" during a real wait.
- If the server gets stuck on something else right after a wait, the note can keep saying "busy" for up to about 18 seconds longer than before; then it reads as stale and the supervisor restarts the server as it always would.
- If the server is stuck in one long stretch of back-to-back waits without a pause, the supervisor now holds off for up to its existing limit of about 5 minutes, where before it usually restarted after about 1. That is the case the "busy" note was made for (the server is waiting on helpers, and restarting it would only throw that work away), and the 5-minute limit itself is unchanged.
- If the note cannot be written at all, everything behaves as before this feature existed: the supervisor restarts an unresponsive server.

## What you need to decide

Nothing. A revert restores the old behaviour exactly; no settings or stored data change.
