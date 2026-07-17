# Playwright operator-seat lease

## What Changed

Playwright MCP calls now acquire a short, host-wide lease for the logged-in browser profile before
they run. Calls from the same drive renew the lease; a competing drive receives a clear busy result
until the current drive goes quiet and the lease expires.

## What to Tell Your User

Two active agent drives no longer fight over the same logged-in browser tab. The second drive waits
instead of clicking into a page the first drive is controlling.

## Summary of New Capabilities

- Host-wide coordination works across separate agent homes on the same machine.
- The lease covers snapshots and reads as well as clicks, preventing page-state interleaving.
- A ten-minute expiry automatically recovers the seat after a crashed or abandoned drive.
