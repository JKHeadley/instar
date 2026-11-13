# The in-flight sync-op marker is mirrored once per burst, not twice per op

<!-- bump: patch -->

## What Changed

`InFlightSyncOpMarker` mirrors its state to `state/tmux-inflight-sync-op.json` for the lifeline supervisor. It rewrote that file (mkdir, writeFile, rename) on every enter and every leave. On a busy server that was about 11% of wall time (CPU profile, 2026-11-13) against about 2% for the tmux spawns it brackets.

The mirror is now written only when the cross-process answer would change: synchronously on a 0 to 1 depth transition unless the file already says in-flight with a stamp at most a quarter of the TTL old, and once more from a `setImmediate` when the loop is free and depth is back to 0 (`flushSyncOpMirror`). Nested ops write nothing; the state directory is created once. The server's wake handler calls `flushSyncOpMirror()` before it reads the file.

Behaviour change for the supervisor: the file now says in-flight for the rest of the loop turn in which a marked op ran. A server hung on something unmarked right after an op is deferred up to the TTL (18 s by default) longer. A turn that never yields but keeps starting marked ops is deferred on every check up to the supervisor's unchanged hard cap (about 5 minutes) instead of about 1 minute. A backward clock step never leaves a future-dated stamp.

## What to Tell Your User

Nothing changes that you will see. The agent's server does less disk work while it checks on its sessions, which makes it less likely to stop answering, and be restarted, when the machine is very busy.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Cheaper in-flight marker for synchronous tmux calls | Automatic |

## Evidence

Studio, 2026-11-13: a 60 s inspector CPU profile attributed 5.9% + 2.7% + 0.8% + 0.7% + 0.6% + smaller rows of wall time to `mirror` under `tmuxSessionExists <- isSessionAlive <- SessionMonitor.checkSession`, and 1.3% to the `spawn` itself. The lifeline log the same night: "Server process alive but unresponsive for 6 checks (~60s) — restarting" at about 19:49, 20:17, 23:27 and 23:54 PST, each killing a running Local Verify.

Tests: `tests/unit/InFlightSyncOpMarker.test.ts` (5 new cases: fifty ops cost two writes; nested ops write nothing; re-stamp after a quarter TTL; bounded in-flight reading when the loop never frees; a flush during an open op writes nothing), `tests/unit/wake-handler-amplifier-guard.test.ts` (the handler flushes before reading), `tests/integration/tmux-resilience-slow-stub.test.ts` updated for the deferred idle write. 21 + 29 + 14 pass; supervisor and sleep-detector marker tests unchanged and passing (16 + 11).
