# The maturation ladder stops hiding numbers from a young log — explained simply

## What the ladder is

Instar has a "maturation ladder": a scoreboard that watches each feature as it moves from switched off, to trial mode, to live on the development agent, to live for everyone. For each step it checks numbers from a shared evidence log, such as how often the feature ran and how often it failed. If a feature fails too often, the ladder shows it needs attention.

## What went wrong

The evidence log keeps itself small. When it gets too big, it moves the current file aside as "file 1" and starts a fresh one. After several of those it deletes the oldest file. If old rows have been deleted, a 14-day error rate could be wrong, because some of the 14 days are missing. So the ladder is careful: when data might be missing, it shows "still collecting" instead of a number. That protects the ladder from saying something is safe when it is not.

The check was too careful. It treated "the log has ever moved a file aside" as "data might be missing", even when nothing had been deleted. On the Studio the log was rebuilt on 20 November and moved one file aside on 25 November. Nothing was deleted, but the ladder hid 196 numbers. Real problems were hidden behind "still collecting". When the raw rows were counted by hand, account follow-me had 37% errors, and 56% of never-silent notices were not delivered.

## What changes

1. The ladder now asks whether rows were really deleted. The log numbers its files from 1 upward. If file 1 is still there, nothing has been deleted yet, so the reading is complete, even if the log is only a few days old. It still says how many days of history it holds. If file 1 is gone, or part of the log has been compressed (and so is not read), the ladder stays careful exactly as before.
2. Some features only run inside another feature. The dark-flag inventory and the blocked-digest escalation only run when the growth analyst is on. Before, the ladder looked only at the child's own switch. A child could look "ready to move up" while its parent was off and nothing was running. A ladder entry can now name the parent switch, and the ladder treats the child as off when the parent is off.

## What stays safe

The careful rule still covers the dangerous case, where rows really were deleted. The ladder only shows numbers; moving a feature up still goes through the existing approval steps. Nothing about the features themselves changes. Reverting this change brings back the old behavior exactly.

## What you need to decide

Nothing. This amends an approved spec without touching the constitution, so it is within the agent's standing approval.
