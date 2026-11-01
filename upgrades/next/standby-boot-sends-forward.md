<!-- bump: patch -->
## What Changed

A machine that does not hold the serving lease, on an agent whose session pool is dark, now waits for the lease to settle before sending an automatic message right after it starts. Before, in those first seconds it sent directly, the send was refused because it was not the lease holder, and the message was held on a path that only retries when the lease comes to that machine. On a permanent standby such as the Mama PC that never happens, so every boot's notices (stuck-session notices, attention posts) sat held for 6 hours and then expired unsent. Now those messages settle (up to 15 seconds) and are forwarded to the lease holder, or kept on the forward retry ladder, which delivers them once the holder is reachable. A dark pool with no paired machine keeps the old direct send with no wait.

## What to Tell Your User

Automatic notices from your other machines no longer pile up as "held replies" after a restart. They now reach you through the machine that sends your messages.

## Summary of New Capabilities

None. This fixes a delivery path; it adds no new switch.

## Evidence

The Mama PC (standby, pool stage dark) logged 448 direct-path holds, all from its own server automation, created in bursts at each server start (e.g. five at 03:12:24Z, its boot time). Unit test: an unsettled lease on a dark pool with a paired peer now answers `settling` for all three settling reasons; with no peer it still answers `local`.
