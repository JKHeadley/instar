# Making "delete this agent" stop only that agent's sessions

## What is going on

Instar has a command, `instar nuke`, that removes an agent: it stops its running sessions, turns off its automatic start, and deletes its folder.

It picks which sessions to stop by their names. Every session whose name starts with the agent's name is stopped. On the Mac Studio, one agent is called `echo` and several others are called things like `echo-wt-1`. So removing `echo` would also stop their sessions, even though they belong to different agents.

Three smaller problems sit alongside it:
- It turns off the automatic start only after stopping the server, so the server can be restarted in between.
- It turns off the automatic start even when that entry points at a different folder.
- It tries the folder delete only after taking everything down, and says "removed" even when the delete failed.

## What changes

- **Sessions.** A session is stopped only if today's name rule matches AND it was started inside this agent's own folder. So `echo-wt-1`'s sessions, which start in `echo-wt-1`'s folder, are left alone. Every similarly named session that is left alone is printed, so nothing happens silently.
- **Exact targets.** Sessions are stopped by the exact id seen when planning, so a different session that later takes the same name is never hit.
- **Automatic start.** It is removed first, and only when it points at this agent's folder. Otherwise it is left as it is and printed.
- **Checks before anything stops.** The folder must be a real folder, not a shortcut to another agent. Every planned delete is checked by the same safety check the delete itself uses. If any check fails, nothing changes.
- **Honest result.** If anything failed, it says what and does not claim success.

## Safeguards

Every change makes the command do less than today or stop before doing anything. It never stops or deletes anything today's command wouldn't. The only new permission is for deleting exactly one folder, the agent's own, worked out by the safety check itself from the agent's name.

A test first reproduces the bug (removing `echo` stops an `echo-wt-1` session) on today's code, then shows the fix keeps that session running.

## What is not in this change

The wider hardening is a separate spec, already queued by the Chief of Staff:
- marking every session with the folder it belongs to;
- locks against a reinstall running at the same time;
- finding hand-started processes;
- changing how the final backup works.

## What needs deciding

Nothing now. After one review round, this comes to the Chief of Staff for approval before it is built.
