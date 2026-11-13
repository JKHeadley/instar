# The hourly safety copy runs in the background — Plain-English Overview

> The one-line version: the server's hourly safety copy of its data no longer runs on the server's one main thread, so a slow disk can no longer make the server stop answering and get killed while the copy runs.

## The problem in one breath

The server does everything on one main thread. On the development agent, once an hour it makes a safety copy of the feedback pipeline's data: about 400 MB in about 1,200 files, and then it deletes the oldest copy. All of that ran on the main thread. On a quiet machine it takes about a second. On 2026-11-13 at 1:35 AM the disk was busy with a test run, the copy and the delete took over a minute, the server answered nothing for that minute, and its supervisor did what it is built to do with a server that does not answer: it killed it. The test run in progress died with it. One change lost two test runs in a row this way.

A profile captured during that freeze showed 46% of the server's time in copying files and 45% in deleting the old copy, both called from the hourly safety copy.

## What already exists

- **The snapshot** — a folder under the agent's backups holding a copy of the chosen files and a small list (the manifest) of what is in it. The newest 20 are kept.
- **The hourly rule** — a check every 15 minutes that starts a snapshot when the newest one is over an hour old. It only runs on the development agent that owns the feedback pipeline.
- **The checkpoint** — just before a snapshot, the feedback database is flushed to a clean state and a small record of its fingerprint is written, so a restore can prove it got the right database.
- **The same snapshot for other triggers** — a manual backup, and the ones made at a promotion or a failover. These are rare and are not changed here.

## What this adds

The hourly snapshot's heavy part (copying the files, writing the manifest, deleting the oldest snapshot) now runs in a worker thread. The main thread starts it and goes straight back to answering.

## The new pieces

- **A worker for the copy** — a second thread inside the same server process that does the copying and deleting. It gets none of the server's passwords or tokens, because copying files needs none.
- **Pinning the databases first** — a database is really two or three files that must match each other. When the copy ran on the main thread, the server could not write to a database halfway through, because the server was stuck copying. In the background that protection is gone, so the main thread first takes an instant copy of just the database files and the checkpoint record (about 8 files; on a Mac this is a "clone", which copies no data). The worker then uses those pinned copies, not the live files.
- **One at a time** — if a snapshot is still copying when the next 15-minute check comes round, no second one starts. If one has been copying for 30 minutes, the server says so in its log.
- **Never mixing moments** — if a database file shows up after the pinning step, the worker leaves it out of this snapshot instead of pairing it with an older database. The next hourly snapshot picks it up.
- **Cleaning up** — the pinned copies sit in a hidden folder beside the snapshots and are removed when the snapshot ends, whether it worked or not. One left behind by a crash is removed by a later snapshot once it is over an hour old.

## The safeguards

**The rules about what may never be copied are unchanged and applied twice.** Secrets, the config file and machine-local records are refused when pinning and again when the worker copies, including for a pinned file.

**A slow copy is never killed by a timer.** Slowness is the very thing this is for, and a killed copy would leave a half-made snapshot behind. A failed snapshot is reported in the log and tried again at the next check, as before.

**A failed snapshot no longer leaves a half-made folder behind.** It removes its own folder, and a folder left by a server that was killed mid-copy is removed once it is a day old. Before, those stayed forever.

**A snapshot made this way restores the same way.** Same folder layout, same manifest, same integrity check. Old and new snapshots are interchangeable.

**Nothing changes for other agents.** The hourly rule only runs on the development agent. Manual, promotion and failover snapshots still run the old way, because they are rare and something waits for their result.

## What you actually need to decide

Nothing. This is a small, reversible change (a revert restores the old behaviour, and no stored data changes shape). It removes one known cause of the server being killed under load; it is not the only cause, and the others are tracked under the same commitment (CMT-1718).

The two places where the clean-up of leftover working folders skips a folder it cannot read are each marked with the reason, so the project-wide check for quietly swallowed errors stays at its agreed count.
