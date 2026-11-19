# Closing a gap in the file-deletion safety check

## What is going on

Instar has a safety check that stops any part of the agent from deleting or moving files in the agent's own program code. There is one shortcut in it: files in the agent's private `.instar` folder (its logs, locks and saved state) may always be deleted, because they are not code.

The shortcut was written too loosely. It allows any file whose path contains `.instar` anywhere. Every agent lives in a folder like `~/.instar/agents/echo`, so every path in an agent's folder contains `.instar`, including its program code. So the safety check does nothing for anything inside an agent's folder.

We measured what the shortcut was actually used for on the Mac Studio, across 1,739 recorded deletions:
- almost all were the agent's private `.instar` folder, as intended;
- 294 were machine-wide lock files, which the main safety check allows anyway;
- 3 were a small test that the feedback system cleans up after itself.

None touched program code. So the gap has not been used for harm. But nothing stops it.

## What changes

- **The shortcut covers what it was meant to:** only the agent's own private `.instar` folder.
- **Three small jobs that relied on the gap get their own named permissions,** each for exactly its own files: the feedback system's test, removing a stale lock file in a working copy, and removing a half-made copy of the project's libraries.
- **The check looks further up.** Today it can be fooled when an ordinary project folder sits inside the agent's folder. After this change it checks every folder above, not just the nearest one.
- **It starts in watch-only mode.** For at least two weeks, the old rule still decides, and every time the new rule would have refused something, a note is written in the safety log. Those notes are kept in their own file, which is not cleared every hour like the main safety log, and is only ever added to. If it fills up, it stops and says the watch is incomplete, rather than dropping notes. They show whether anything else quietly relied on the gap, before anything is refused for real.

The command that deletes a whole agent (`instar nuke`) is handled separately: it needs its own fix first, so the new rule cannot be switched on before that lands.

## What needs deciding

Nothing now. After two weeks of notes, the Chief of Staff decides whether to switch the new rule on, with the numbers in hand.
Approved by the Chief of Staff at 01:11 PT, to be built watch-only.
