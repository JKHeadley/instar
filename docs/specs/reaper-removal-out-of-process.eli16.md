# Cleaning up old working copies without slowing the agent down

## What is going on

When the agent works on its own code, its sessions make separate working copies of the project. On the Mac Studio, about 74 to 86 new copies appear every day. Nearly all of them are made by the agent's own working sessions, a few by its feedback pipeline. Each takes room on the disk, and finished ones are never removed. The disk fills by about 4 GB an hour on busy evenings.

A cleanup tool exists, but it has two problems if it were switched on for real. It runs only once a day and removes at most 20 copies, fewer than are made each day. And each removal runs inside the agent's main server process and takes about 3 seconds. While it runs, the server can't answer anything, so a full cleanup would freeze the agent for about a minute.

Of yesterday's new copies, 11 already had their work merged and 8 had their work closed, so about a quarter were finished within the day. Most of the rest finish later, when their work is merged.

## What changes

- **Checking and removal move into their own background program,** run at low priority, like the disk cleaner already does. The agent's main server no longer does any of the slow work itself. Only one such program runs at a time. A copy is first moved into a trash folder in one instant step, then deleted, so an interruption can never leave a half-removed copy behind.
- **The cleanup checks every hour instead of once a day.** The existing backlog of about 120 finished copies clears in about six hours instead of about six days, and a copy that becomes finished is cleaned up within about an hour.
- **Copies whose work was closed without merging count as finished** only when that work is still saved on GitHub, so nothing is lost.
- **Right before removing each copy, the background program checks everything again.** If the copy changed, is in use, or isn't finished, it stays.

## What this does not fix yet

Most new copies carry their own copy of the project's libraries. That copy shares disk space with the original, but the cleanup still treats it as possible work, so those copies stay. Changing that rule is a separate decision for the Chief of Staff, raised alongside this.

## Safeguards

- Each run removes at most 20 copies and has a 15-minute safety limit. Both limits come from measuring how long a removal takes and how fast copies are made.
- Copies with no pull request at all, such as test setups, are not touched.
- Actually removing copies stays switched off. The Chief of Staff turns it on later, after seeing the numbers.

## What needs deciding

Nothing now. The design comes to the Chief of Staff for approval before it is built.
Approved by the Chief of Staff, 20:49 PT: build with real removal off.
