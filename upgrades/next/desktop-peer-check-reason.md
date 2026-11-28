<!-- bump: patch -->

## What Changed

When the Remote Desktop front cannot check another machine's desktop, its server log now says why. One line names the machine, gives a set reason word (timeout, unreachable, connect, http-<status>, or a probe code), and gives the milliseconds taken. Before, that reason was dropped. The person still sees the same "Could not check this machine's desktop" line.

## What to Tell Your User

Nothing changes on screen. If a machine keeps showing "Could not check", I can now see why in the log and act on it.

## Summary of New Capabilities

None. A log line on an existing failure path.
