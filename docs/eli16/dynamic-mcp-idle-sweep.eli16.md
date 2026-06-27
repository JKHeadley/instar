# Dynamic MCP — the automatic idle-offload sweep (ELI16 overview)

## What this adds

The explicit "drop this tool, I'm done with it" already works. This adds the
*automatic* version: a background check that notices when a heavy tool (like the
browser) has sat completely unused under a running session for a good while, and
drops it on its own so the resources come back without anyone asking.

## How it decides

Every so often it looks at the heavy tool-helpers running under live sessions. For
each one it keeps a little stopwatch of "how long has this been idle in a row." If
the session is busy using its tools — or if it can't even tell whether it's busy —
the stopwatch resets to zero (better to keep a tool than yank it from someone
mid-task). Only when a tool has been provably idle past the window (about half an
hour by default) does it ask to drop it, through the exact same permission-checked
path an explicit request uses — so on a non-preapproved chat it still asks you
first, never restarts silently.

## Why it's safe

It's pure orchestration over injected helpers — it lists nothing, kills nothing,
restarts nothing by itself; it just decides and delegates to the existing
drop-it-safely machinery. It ships off, and in "rehearsal" mode it only writes a log
line ("would drop X") so we can watch what it *would* do before letting it act. Nine
tests pin the stopwatch (accrue, reset on busy, reset on unknown), the keep-warm
exclusion, the rehearsal-logs-only mode, skipping sessions it can't place, and
cleaning up stopwatches for tools that have gone away. It isn't wired to a timer
yet — that thin final step starts it on a schedule.
