# Worktree reaper and gate records: the plain version

When an agent builds a change, it works in a separate copy of the code called a worktree. These pile up in one folder. Creating a new worktree is refused at 500 folders, so a stuck pile eventually stops all building on that machine. That happened on the Mac Studio: 514 folders.

There is a cleaner, the reaper. It only removes a worktree that is idle, fully merged, and has no leftover files, because anything left over might be someone's only copy of real work.

The commit gate writes small record files into each worktree each time it reviews a commit. Those files looked like leftover work, so the cleaner kept those worktrees. This change teaches the cleaner to recognise them by their exact name pattern, copy them to an archive folder in the agent's home, check that each copy is identical, and only then remove the worktree. If the copy fails, or anything else is in the worktree, the worktree stays.

This is not the whole reason worktrees pile up. Measured on the Mac Studio, every one of the 303 kept worktrees also holds other ignored files such as build output, and an earlier safety decision says those keep a worktree too. This change leaves that decision alone, so by itself it does not free those worktrees. Changing that rule is a separate decision.

The second change is the refusal message. It used to say only that there were too many directories. About 190 of them are not worktrees at all but other systems' folders, which misled whoever read it. Now it says how many are worktrees, how many are other folders, and what those folders are called. The limit stays at 500 and still counts everything.

The cleaner stays switched off by default. Nothing here turns it on.
