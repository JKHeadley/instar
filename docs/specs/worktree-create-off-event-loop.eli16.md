# Making a workspace no longer freezes the server — Plain-English Overview

> The one-line version: when a new conversation needed its own copy of a project, the server made that copy while doing nothing else, sometimes for over a minute; it now makes the copy in the background and keeps answering.

## The problem in one breath

Some conversations get their own private copy of a project to work in, so that two conversations cannot trample each other's files. The first time such a conversation starts, the server creates that copy: it asks git to check out the whole project, then copies the project's installed libraries next to it.

For a small project this takes a moment. For the instar project itself it means writing out thousands of files, and on a disk that is already busy git had been running for 26 seconds when it was observed on 2026-11-13, and a copy of the libraries can follow it.

The server did all of this "synchronously": it started git and then stood still until git finished. A server standing still answers nothing: no messages, no health checks. A separate watchdog checks the server's health every ten seconds, and after a minute of silence it restarts the server. That is what happened at 6:10 AM: a new bug-report conversation needed a workspace, the server stood still for a minute, and the watchdog restarted it. The restart threw away two long test runs that were in progress.

## What already exists

- **The workspace manager** — creates one private copy per conversation, remembers which conversation owns which copy, and makes sure only one live session uses a copy at a time.
- **The guarded git runner** — every git command the server runs goes through one checkpoint that refuses dangerous commands and writes an audit line. It has a "start it and wait" form and a "start it and carry on" form.
- **The watchdog** — restarts a server that stays silent too long. It is right to exist; the fault was the server going silent for a routine job.

## What this adds

The three slow steps (check out the copy, or clone it, and copy the libraries) now use the "start it and carry on" form. The server starts git, goes back to answering everything else, and picks the job up again when git reports that it has finished.

## The new pieces

- **A background git step with a time limit.** It goes through the same checkpoint as before. If git has not finished within its limit, git and the helper programs it started are all stopped, and the workspace request fails straight away with a clear message.
- **A longer limit for the checkout.** Two minutes, where it had thirty seconds. Thirty seconds was tight even before; now that a slow checkout delays only the one conversation waiting for it, there is no reason to give up early.
- **One creation per conversation at a time.** Because the server no longer stands still, a second request for the same new conversation can arrive while the first copy is being made. The second request now waits for that same copy. Without this, both would have asked git to create the same folder and one would have failed with a confusing git error.

## The safeguards

**Same checkpoint.** The background form runs through the same guard as the old form: the same refusals, the same cleaned-up environment, the same audit line. A test confirms a read-only command is still refused there.

**Failures are not remembered.** If a creation fails, the record of it being "in progress" is cleared, so the next request starts fresh. A test makes git fail once and then succeed.

**Proved by reverting.** With the old code put back, the test that checks the server keeps working while git is busy fails: the server's timers fire zero times during the checkout. With the change they fire normally.

**Nothing else moved.** Which copy belongs to which conversation, the locks, the signed records and the history log are untouched. The 32 existing tests of the workspace manager pass unchanged.

## What it does not fix

If making the copy is stopped at its time limit, a half-made copy is left on disk, and the next attempt for that conversation picks it up as if it were complete. That was already true before this change. It should now happen less often, because the limit is two minutes where it was thirty seconds. A clean-up step was written for it and taken out again, because an independent reviewer showed it could leave a conversation unable to get a workspace at all. Doing it properly is a separate piece of work, which is on the list.

## What it costs

Nothing measurable. The same commands run; the server is simply free while they do.

## What you need to decide

Nothing. This is a narrow repair with no setting. Undoing it is a plain revert.
