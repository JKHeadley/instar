# Bounded tail-reads for the 12MB telegram-log + 14MB feedback-store — ELI16

## What this is

Your agent's server runs everything on one main thread. If any single operation makes that thread
wait, *everything* waits — the dashboard, your messages, every background check. When that wait is
long enough, the dashboard's live connection drops (the "Disconnected" flapping you may have seen).

This fixes the THIRD and FOURTH freezes behind that flapping. (The first was a slow shared terminal
manager; the second was reading the macOS keychain the blocking way; the third was a 13MB job-history
file re-read whole every minute — all already fixed.) This one is about two more big files.

## What was wrong

Your agent keeps a running log of every Telegram message it has ever sent or received, in a file
called `telegram-messages.jsonl`. That file has grown to about **12 megabytes**. Several background
checks only ever need to glance at the LAST few messages in that log — the last 50, or the last 100.
But the way they were written, they read the **entire 12MB file** from disk and chopped it up, just
to look at the tail. And some of these checks run on a **5-minute timer**, every few minutes, forever.
Each one froze the server for up to **20 seconds**. (A second large file, a 14MB feedback log, had
the same problem: it was re-read and re-parsed from scratch every processing pass even when nothing
had changed.)

A frozen main thread uses almost no CPU, so the freeze even looked to the agent like the laptop had
briefly gone to sleep — a misleading signal on top of a real problem.

## What's new

Two simple changes, both behavior-preserving:

- The background checks that only want the tail of the message log now read just the **last chunk**
  of the file (a 512-kilobyte window — far more than enough to hold the last few hundred messages),
  not the whole thing. So they're instant no matter how big the file gets.
- The 14MB feedback log now remembers the file's size and last-modified time. If nothing changed
  since it last read it, it returns the copy it already has, reading nothing from disk.

So those per-call whole-file reads are gone from every one of these hot paths, and the freezes they
caused are eliminated. Everything these checks actually do — what they look for, how they parse,
how they recover from a corrupt file — is unchanged, and proven by tests. One of the new tests even
plants a problem message at the very END of a multi-megabyte log to prove the tail-read still catches
recent entries.

## What you need to decide

Nothing. It's self-contained and low-risk, fully covered by tests. One honest note: the log files
themselves still grow large over time — putting a size cap on them is a separate cleanup I've flagged
to track, not fixed here. Reading them is no longer a freeze; capping their growth comes next.
