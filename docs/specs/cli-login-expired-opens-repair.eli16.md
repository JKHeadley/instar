# "Login expired" on screen now starts the sign-in repair — plain-English overview

## What happened

On 2026-10-22 the Claude login for one subscription account (headley.justin@gmail.com) on the Mac Studio stopped working at about 04:10. For the next eight hours every Claude session the agent started under that login showed `Login expired · Please run /login` and did nothing. That included the operator's own "Instar Agent Management" conversation, which silently stopped answering. The automatic sign-in repair, which exists exactly for this, never started. The operator had to type `/login` by hand.

## Why the repair never started

Two different parts of the system each saw the problem, and neither one could start the repair.

1. **The account checker (quota poller).** Every 15 minutes it reads each account's saved login. This time the saved login no longer looked like a valid token. By design, an unreadable saved login on its own is treated as "unconfirmed": a file can be briefly unreadable for harmless reasons, so it never changes the account's status by itself. And because there was no readable token, the checker never tried the login against Anthropic either, so there was never a "login refused" answer that would have counted as proof. The account stayed marked **active**.
2. **The session monitor.** It saw "Login expired" on screen more than 40 times that day and ended each stuck job so it would stop holding a slot. But it deliberately does not change account status. That is the checker's job.

The result: an account that could not do any work stayed "active". New sessions kept being placed on it, and no repair was ever offered.

## What changes

The session monitor now passes each "Login expired" sighting to the account checker as a hint. The checker stays the only part that decides an account's status. It changes the rule in one narrow case only:

- if the saved login **cannot be read**, and
- at least **two different sessions** under that same login showed Claude Code's own "Login expired" screen **within the last hour**,

then the checker marks the account **needs sign-in**. That is the same state a refused login produces today, so the existing automatic repair picks it up exactly as before, with all its existing safety checks (dedicated browser profile, identity checks, approval or unattended mode, retry limits).

## What does NOT change

- A readable login is still judged only by a real login check against Anthropic. Hints never override a working login.
- One session alone, or sightings more than an hour old, change nothing.
- The repair itself is untouched: same admission rules, same browser procedure, same verification.
- Sessions talking *about* "Login expired" (quoting a log, discussing the incident) are never counted. The screen-reading rule only matches Claude Code's own rendered message at the bottom of the screen.

## What you need to decide

Nothing. It is a narrow fix inside the existing repair system. To undo it, revert the change.
