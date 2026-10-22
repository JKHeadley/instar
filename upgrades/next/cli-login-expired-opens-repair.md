## What Changed

- **A Claude login that has stopped working now gets repaired automatically, even when its saved login file can't be read.** Before, if the saved login was unreadable, the account stayed marked "active" (an unreadable file alone is never treated as proof). New sessions kept landing on the dead login and the automatic sign-in repair never started. Now, when Claude Code itself shows "Login expired" in two different sessions under that login within an hour, the account is marked as needing sign-in and the usual repair takes over.
- The session monitor that ends stuck jobs at the "Login expired" screen now reports each sighting to the account checker. The account checker still decides on its own; a working login is never changed by these sightings, and a login whose keychain is merely locked (for example right after a reboot) is deliberately left alone, since a repair could not write to it either.
- The sign-in history now says when an unreadable-login watch ended because the account was confirmed dead ("escalated") rather than because the login came back ("resolved").

## What to Tell Your User

If one of your subscription logins expires, I should now notice it and start fixing it myself, instead of quietly trying to use the dead login for hours. You may see it switch to "needs sign-in" on the Subscriptions tab while the repair runs.

## Evidence

- 2026-10-22 incident on the Mac Studio: the headley.justin@gmail.com login was dead for about 8 hours and stayed "active" while 40+ sessions stopped at "Login expired". No repair episode was opened.
- New tests: two sessions plus an unreadable login gives "needs sign-in" and the repair accepts the cause. One session, old sightings, a different login, or a readable login change nothing. An end-to-end run from real session kills into the real account checker.

## Summary of New Capabilities

- No new capability. The existing automatic sign-in repair now also starts when Claude Code's own "Login expired" screen confirms an unreadable saved login.
