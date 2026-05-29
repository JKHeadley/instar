# In plain English: don't read the token database after it's been shut

## What this is about

The agent keeps a small database of how many tokens it has used (the "token
ledger"). In the background, it slowly scans through the agent's chat logs to
count usage. To avoid hogging the computer, that scan does a little work, then
pauses to let everything else run, then does a little more, and so on.

## What went wrong

When the agent (or a test) shuts the database down, it might do so *exactly
during one of those pauses*. When the scan wakes back up from its pause, it tries
to read the next chat-log file and write to the database — but the database is
already closed. The database library then complains: "the database connection is
not open."

In practice this was harmless: it only happened while shutting things down, the
error was caught and logged, and nothing was lost or crashed. But it printed a
scary-looking error line that could hide *real* problems, and reading something
after you've closed it is just a latent bug waiting to bite.

## What already exists

The recent startup fix (the one that stopped a big token database from freezing
the agent on boot) added a simple "I'm closed now" flag the ledger sets when it
shuts down, and the background backfill already checks that flag. The scanning
loop, though, never looked at it.

## What's new

The scanning loop now checks that same "I'm closed now" flag right after each
pause — before it touches the database or the disk again. If the ledger was
closed during the pause, the scan simply stops cleanly instead of trying to use
the closed database. That's the whole change: one quick check in two spots.

The all-at-once (non-paused) version of the scan doesn't need this, because it
never pauses, so a shutdown can't sneak in halfway through it.

## What the reader needs to decide

Nothing to configure, nothing for a user to notice. It only changes what happens
during shutdown: instead of a caught-and-logged "database not open" error, the
scan ends quietly. A test proves the fix works — it deliberately closes the
database mid-scan and confirms the scan now ends cleanly (and confirms that
without the fix, the old error comes back). This is a small, safe robustness
cleanup that finishes the shutdown-safety work started by the startup fix.
