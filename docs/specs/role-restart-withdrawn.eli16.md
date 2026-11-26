# A restart that is no longer needed is taken back — Plain-English Overview

Written 20 November 2026. It can be read with no other background.

> The one-line version: when a machine loses the lead role and gets it back before its planned restart has happened, the restart is now cancelled. Before, it still happened, minutes later, for a reason that was no longer true.

## Words used here

- **The lead role (the lease):** when an agent runs on several computers, exactly one of them is in charge at a time. It runs the scheduled jobs, answers messages and runs the test line. The others stand by.
- **Role restart:** when a computer's role changes, its server restarts once, so that the normal start-up builds what the new role needs.
- **Planned restart:** a restart that waits politely. It waits while a test run is in progress, for up to three hours.

## The problem

A role restart is asked for by writing a small request file. The request waits while a test run is in progress. Nothing ever took the request back.

So this could happen, and on 20 November 2026 it did, on the Mac Studio:

1. 15:43 UTC. The Studio lost the lead role to the Laptop. It asked for a role restart ("this machine gave up the lease"). A test run was in progress, so the restart waited.
2. 15:53 UTC. The Laptop handed the lead role back. The Studio was now exactly what it had been when it started: the lead. There was nothing left for a restart to fix.
3. 16:03 UTC. The waiting restart ran anyway. It ended the test run that had started in between, and for the length of the start-up the lead machine was silent, which is the moment another machine may decide to take over.

That morning the lead role moved between the two machines 36 times in six hours, and the test line finished 2 changes. Not all of that was this defect, but every one of these stale restarts cost a test run and opened a new chance for the role to move again.

## What changes

Once a minute, and at every role change, the server already checks whether its role still matches the role it started with. When the role matches again and a role restart from this same server is still waiting, the server now deletes the request and says so in its log.

Only that one kind of request is removed:

- a request written for a role change, and
- written by this running server (the request records which process wrote it).

A restart asked for by an update, by a person or by any other part of the system is never touched.

## What stays the same

- A machine whose role really did change still restarts once, as before.
- The limit of one role restart per 15 minutes stays. The time of the request is kept even when the request is taken back, so a role that keeps moving cannot cause a restart each time.
- Jobs still stop at once on a machine that loses the lead role, whatever happens to the restart.

## What it costs

Nothing is delayed and nothing new can be blocked. One file read a minute on a machine whose role matches its start-up role.

## How we will know it works

- The server log line "the waiting role restart is withdrawn" appears when it happens.
- The supervisor's log no longer shows "Restart requested by role-change (... gave up the lease)" on a machine that holds the lead role at that moment.
- Automated tests cover: a waiting role request is removed; an update's request is kept; a role request from another process is kept; no request or an unreadable one changes nothing.
