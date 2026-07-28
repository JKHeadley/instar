# Proactive Autonomous Compaction — ELI16

A long-running agent is like someone filling a notebook while working. If the notebook becomes completely full, recovering is harder and the session may stall. Claude already shows how much notebook space remains.

This feature watches only autonomous Claude sessions. When 85% of the context is used, it waits until Claude is genuinely between turns, then asks Claude to compact its notes. It does nothing while Claude is working, does nothing when the work state is uncertain, and does nothing to normal interactive sessions.

The feature ships off. Its first enabled posture is also observation-only: it records what it would have done without pressing `/compact`.

There are several brakes because an early compaction is useful only when it is
safer than waiting. A normal chat is excluded. Codex and other frameworks are
excluded because their context signals and compaction controls differ. If the
session pane cannot be read, if the percentage is missing, or if the work-state
probe is unsure whether a tool is still running, the monitor does nothing. A
per-session cooldown also prevents repeated compaction requests if the display
does not refresh immediately. Operators can first inspect dry-run logs, then
enable live behavior explicitly; turning the feature off stops the monitor at
the next server restart.
