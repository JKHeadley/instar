# Making "delete this agent" touch only that agent

## What is going on

Instar has a command, `instar nuke`, that removes an agent completely: it stops its running sessions, turns off its automatic start, and deletes its folder.

It finds the sessions to stop by their names. Every session whose name starts with the agent's name gets stopped. On the Mac Studio, one agent is called `echo`, and several others have names that start with `echo-`, like `echo-wt-1`. So removing `echo` would also stop their sessions, even though they belong to different agents.

Two smaller problems sit alongside it:
- The command stops everything first, and only then finds out whether it is allowed to delete the folder. If the delete then fails, the agent is already half taken apart.
- It says it succeeded even when the delete failed.

## What changes

- **Sessions by ownership.** The command stops only sessions that were started inside this agent's own folder. A name that merely starts the same way doesn't count. Any similarly named sessions it leaves alone are listed, so nothing happens silently.
- **Auto-start checked first.** It removes the automatic-start entry only after checking that the entry really points at this agent's folder.
- **Everything checked before anything is stopped.** Before stopping anything, it checks that the folder is a real folder (not a shortcut to another agent) and that the delete will be allowed. If any check fails, it stops with nothing changed.
- **Honest result.** If the delete fails, it says so.

## Safeguards

The command can only ever do less than it does today, never more. The one deletion it is allowed is exactly one folder, worked out by the safety check itself from the agent's name.

## What needs deciding

Nothing now. The design comes to the Chief of Staff for approval before it is built.

This draft was replaced by the narrower spec nuke-teardown-narrowing, which is the one being built. It has no on/off switch and no maturation ladder.
