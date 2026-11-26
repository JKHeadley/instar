<!-- bump: patch -->

## What Changed

When scheduled jobs are waiting, the scheduler checks whether a tracked job has actually exited, including when tmux has retained its dead pane. It releases a confirmed dead job through the normal completion path. A process that is still running or whose liveness cannot be verified keeps its slot.

If a nonempty queue stops advancing for longer than the longest enabled local job timeout, the scheduler records an agent-health alert.

## What to Tell Your User

A crashed scheduled job is less likely to hold up the rest of the queue. The agent can also see when the queue has been stuck unusually long.

## Summary of New Capabilities

None. This makes the existing scheduler more reliable.
