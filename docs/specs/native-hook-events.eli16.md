# Reporting session events without starting a program each time — plain-English overview

## What this change is

While an agent works, Claude Code runs small "hook" programs at fixed moments: before a command runs, after it finishes, when the session stops, and so on. Instar uses these for safety checks and for keeping a record of what each session did. Each hook starts as a separate little program, and each start costs a few hundredths of a second and some memory. One ordinary command currently starts about 12 of them before it runs and 3 after.

One of these, the event reporter, does nothing but tell the main server "this happened". It runs at nine different moments, including after every single command. Claude Code can now send that news to the server directly, with no program at all, so this change switches the reporter over to that.

While measuring, I found the reporter has been mislabelling almost everything: every event except "a tool was used" has been recorded as "Unknown", so features that wait for "session stopped" or "task completed" have never seen one. Switching over fixes that. One of those waiting features would have checked every conversation whenever any one of them compacted its memory, so this change makes it check only the conversation it concerns before it is ever switched on.

## What's new

- The event reporter becomes a direct message to the server: no extra program.
- The server keeps only the small set of details it needs and throws away the rest (for example the full output of a command, which can be huge or contain secrets).
- Each detail it keeps has a fixed type and size limit, and any password-like text is blanked out before the short message excerpt is stored. If the server gets too many events at once, it drops the extras and counts them instead of using up memory.
- The folder where these records are kept is now excluded from the agent's automatic backups to its code repository. One agent's repository was already saving a copy, which would have sent it off the machine.
- A list the server keeps of which helpers are still running gets a one-hour limit, so one missed "helper finished" message can't leave a session marked busy forever (which would silence a safety check).
- Two events where the reporter should never have been registered are cleaned up: on those, Claude Code expects the hook to create or remove a working copy itself, and the reporter does neither, which very likely breaks Claude Code's own working-copy feature today. That fix goes live straight away.
- Skipping checks that don't apply to a command was considered and set aside for now: Claude Code's rules for it would make some checks run twice, and one check does more than it appears to.

## Safeguards

- Off by default, one switch. Switched off, everything is as it is today except the working-copy fix.
- Checks that can block a command are not touched at all.
- Older Claude Code versions keep the old setup automatically.

## What a reader needs to decide

Whether to switch it on once the measurements are in the pull request: how many reporter programs a session starts, and how much processor time they use, with each switch off and on.
