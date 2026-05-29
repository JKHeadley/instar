# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fleet fix — runaway CPU from a server crash/rebuild loop.** Some agents could
get stuck restarting their server hundreds of times while pinning a CPU core.
Two bugs compounded: (1) the wake-socket helper threw an *asynchronous*
EADDRINUSE that the server boot didn't catch, crashing the whole server when a
duplicate/stale `listener.sock` holder was present; (2) the supervisor then
mis-read those bind failures as a native-module (better-sqlite3) problem and
force-rebuilt it on every restart — futile, CPU-heavy node-gyp compiles
(observed fleet-wide: hundreds of rebuilds across several agents). Now the wake
socket degrades gracefully on error (the agent keeps serving without it), and
better-sqlite3 is only rebuilt when it *actually* fails to load with an ABI
mismatch. This stops the loop and frees the CPU it was burning.

## What to Tell Your User

If your machine ever felt hot or an agent seemed to be "restarting a lot," this
removes a cause of that. No action needed — nothing changes in normal operation.

## Summary of New Capabilities

- Wake-socket failures (e.g. a duplicate/stale `listener.sock` holder) degrade
  gracefully instead of crashing the server process.
- better-sqlite3 is rebuilt only on a real `NODE_MODULE_VERSION` ABI mismatch —
  bind failures no longer trigger futile native rebuilds.

## Evidence

- `tests/unit/wake-socket-error-handling.test.ts` (wiring + live-peer EADDRINUSE
  surfaces as a catchable event).
- `tests/unit/server-supervisor-preflight.test.ts` (no rebuild on bind-failure
  when the module loads; rebuild still fires on a real ABI mismatch).
- Side-effects: `upgrades/side-effects/native-rebuild-loop-and-wake-socket-crash-fix.md`.
