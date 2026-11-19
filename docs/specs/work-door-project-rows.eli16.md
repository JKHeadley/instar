# Project rows that say something (plain version)

## What this is

The Work page in the Instar app and the dashboard has a Projects list. Each project the Chief of Staff tracks gets a row. Justin looked at it and said it was close to useless: it shows the goal and a list of requirements, and the only button jumps to the conversation. Nothing tells him what happens next or what he can do.

The Chief of Staff already knows a lot more. Every time it checks a project it writes one plain sentence about where the project stands. It knows when a project is waiting on Justin and why, which items on the "done when" list are automatic checks and which only Justin can judge, when the next check is, and whether it gave up after restarting a project several times without progress. This change puts all of that on the row.

## What is new

The row now shows:

- **Next step**: the Chief of Staff's latest sentence about the project.
- **Why it waits on you**, when it does. For example: "Every automatic check passes. It needs you to check: the app feels right on a real phone."
- **Each done item's state** in words: "Passes", "Fails", "Not checked yet", "Waiting for you to check", "Checked by you".
- **When it was last checked and when it is next checked**, and if the Chief of Staff stopped retrying, why.

And three buttons on the phone:

1. **Ask for an update.** The Chief of Staff checks that project right now, instead of waiting for its next round, and the row refreshes. No Face ID, because it only asks the Chief of Staff to do sooner what it does on its own anyway. To keep cost down, it can only be asked once every 10 minutes per project, and only the machine that is currently doing the checks can run it.
2. **Pause / Resume.** Stops the Chief of Staff from checking, restarting or nudging the project, until resumed. This needs Face ID on Justin's phone.
3. **Mark checked** on an item only Justin can judge. Also Face ID. When every such item is checked and every automatic check passes, the Chief of Staff finishes the project on its next check, just like the existing "Confirm it's done" button does.

## The safeguards

- Pause and Mark checked are Justin's own decisions, so only his phone's Face ID can make them. The agent cannot do it for him, and the dashboard PIN cannot either (any session can read the PIN, so it does not prove Justin pressed anything).
- The signed tap names the exact project, the exact item and a fingerprint of the item's exact text. If the item's wording changed after Justin looked at it, the tap is refused and he is asked to refresh, so he never confirms something he did not read.
- If the project's done list is edited later, earlier checks no longer count.
- Older machines that have not updated yet simply ignore the new "checked" records instead of breaking; the project then closes once an updated machine checks it.

## What needs deciding

Nothing for Justin. Showing these things was already approved. Pausing from the phone and marking items checked are small additions to two approved designs, and they follow rules those designs already state (only the owner pauses; every judged item needs the owner's tap). No constitution text changes.
