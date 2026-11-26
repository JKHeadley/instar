# Job Sessions Stuck at an Expired Login — Plain-English Overview

> The one-line version: a scheduled job that starts under a signed-out login is now ended about a minute later, instead of sitting idle for eight hours and blocking every other job.

## The problem in one breath

Many of Instar's scheduled jobs run as ordinary interactive Claude sessions, each started under one of the logins in the account pool. On 18 October one of those logins (its sign-in had expired two days earlier) was still handed out to new job sessions, because the pool's quota check could still read it. Each job session opened, Claude printed "Login expired · Please run /login", and the session sat there. Nothing watched for that screen. The session monitor only asks two questions about these sessions: "did it print its finished marker?" and "has it run past its eight-hour limit?". So each dead session held one of the machine's two job slots for eight hours. With both slots taken, no other job ran: the feedback sorting jobs, the health check and everything else on the Mac Studio went quiet from 08:35 to 16:35, and again after that.

## What already exists

- **The job scheduler** — runs at most two job sessions at a time on this machine and queues the rest.
- **The session monitor** — checks each running job session every few seconds for its finished marker and for its eight-hour limit.
- **The account pool's own sign-in checks** — decide, with several corroborating checks, when a login is marked as needing a new sign-in. They eventually caught this login.
- **A shared helper for "what is on the last lines of the screen"** — used by the other screen checks, so a phrase that scrolled up long ago does not count.

## What this adds

One more question in the session monitor for these job sessions: "is the last screen Claude's own expired-login message?" If it is, and it is still there a minute later, the session is ended. That frees its job slot, records the reason, and reports a degradation that names which login folder was signed out. The job runs again at its next scheduled time.

## The safeguards

**It only reacts to Claude's own message.** The line must start with Claude's message marker and then the exact sign-in error. A session that is talking about an expired login, or quoting a log line that contains the words, is not ended. The tests include exactly that case.

**One sighting is never enough.** The screen must still show the message a minute after it was first seen. If it goes away, the sighting is forgotten.

**It does not touch account state.** It never marks the login as signed out or moves anything between accounts. The pool's own corroborated checks stay the only authority over that.

**Protected and standing sessions are left alone**, exactly as with the eight-hour limit.

## What this does not do

It does not sign the login in again; that still needs a sign-in. It does not stop the pool handing that login to the next job, so until the login is fixed or the pool marks it, a job may start there and be ended a minute later. That costs one minute per job instead of eight hours.

## What you need to decide

Nothing. The change has no setting. The expired login on the Mac Studio still needs a fresh sign-in, which the existing sign-in repair process handles.
