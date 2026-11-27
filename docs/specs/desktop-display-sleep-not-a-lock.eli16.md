# A sleeping Mac screen is not a locked one — Plain-English Overview

## The problem in one breath

When a Mac's screen goes to sleep, some Macs set the same flag a lock sets, even though no password is needed to get back in. Remote Desktop read that flag and refused the Mac as "not ready", exactly as if it were locked. On 27 November the Mac Studio did this: its screen was only asleep, and a moment of simulated mouse activity woke it with no password.

## What already exists

Remote Desktop checks that the Mac is ready before a session starts: permissions granted, a screen showing, someone signed in at it. The small helper app on each Mac reports the lock flag. Instar's machine-care code already treats that flag as one clue, never the answer.

## What this adds

When a session starts and the only thing wrong is that flag, Instar now asks macOS directly whether the Mac is locked. If macOS says it is not locked, Instar wakes the screen, the way moving the mouse would, and checks readiness again for up to 3 seconds. If macOS says it is locked, or the answer can't be read, the Mac is refused exactly as before.

## The safeguards

- A locked Mac is never woken, and it is still refused.
- The wake happens only when a session starts, at most once per attempt, never in the background checks.
- Every wake attempt is written to the desktop access log.
- The helper app on each Mac is not changed, so no Mac needs its macOS permissions granted again.
- Tests can never wake the screen of the machine running them.

## What ships when

It ships with the next release. Windows and Linux are unchanged.

## What you actually need to decide

Nothing.
