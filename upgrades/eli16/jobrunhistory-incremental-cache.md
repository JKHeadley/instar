# JobRunHistory incremental cache — event-loop freeze fix — ELI16

## What this is

Your agent's server runs everything on one main thread. If any single operation makes that thread
wait, *everything* waits — the dashboard, your messages, every background check. That's a "freeze,"
and a long-enough freeze drops the dashboard's live connection (the "Disconnected" flapping).

This fixes the THIRD distinct freeze behind that flapping. (The first was a slow shared terminal
manager; the second was reading the macOS keychain the blocking way — both already fixed.) This one:
the agent keeps a log of every background job it has ever run, in a file called `job-runs.jsonl`. That
file has grown to about **13 megabytes**. And every time a job finished or started — which happens
about every minute — the server read the WHOLE 13MB file from disk and re-parsed all of it, on the
main thread. That single operation froze the server for **13 to 16 seconds**, every minute or so. It
even looked to the agent like the laptop had gone to sleep (a blocked main thread uses almost no CPU,
so the sleep-detector misreads it).

## What already exists

The agent already uses this "keep a cached copy instead of re-reading from scratch" pattern elsewhere
(the cartographer code map serves a cached snapshot instead of recomputing live). This job-history
file just never got that treatment — it re-read the whole thing every single time.

## What's new

The job-run history now keeps a **smart in-memory cache**. It remembers the file's size and
last-modified time:
- If nothing changed since last time → it returns the cached copy instantly, reading nothing from
  disk.
- If a new line was appended (the normal case) → it reads ONLY the new bit at the end, not the whole
  13MB.
- If the file was compacted (shrunk) → it does one full re-read to stay correct.

So the per-call full-file read+parse is gone from every hot path. The freeze it caused is eliminated.
All the existing behavior (how it dedupes, recovers from a corrupt file, etc.) is preserved exactly,
proven by the test suite.

## What you need to decide

Nothing. It's a self-contained, low-risk read-path cache, fully covered by tests. One honest note:
the `job-runs.jsonl` file (and a separate 91MB cartographer file) keep growing without a size limit —
the cache makes reading them cheap regardless, but capping their growth is a separate cleanup item
I've flagged to track, not fixed here.
