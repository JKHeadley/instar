# The orphan-process check no longer freezes the server for seconds

<!-- bump: patch -->

## What Changed

`OrphanProcessReaper.classifyProcesses` looked up each candidate process's parent pid and parent command with two synchronous `ps -p` spawns per process. On a loaded host that held the server's event loop for 3-4 seconds per poll (CPU profile of an agent server during graph work, 2026-11-18: two of the four longest uninterrupted stalls were this alone). It now reads one `ps -A -o pid=,ppid=,command=` listing per classify pass and answers both lookups from it; a pid missing from the listing (it exited, or the listing failed) falls back to the per-pid query, so classifications are unchanged.

## What to Tell Your User

- **Fewer pauses**: "A background check that looks for leftover processes used to freeze me for a few seconds at a time on a busy machine; it now does its work in one quick step."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| One process listing per orphan check instead of two spawns per process | Automatic |

## Evidence

Profile: `getParentPid`/`getProcessCommand` → `spawnSync` were 3.5 s of a 3.6 s stall and 2.5 s of a 3.5 s stall. Tests: `tests/unit/orphan-reaper-ps-snapshot.test.ts` (one `ps -A` per pass and no per-pid spawn when the listing has the pid; fallback for a missing pid gives the same classification), plus the existing reaper suites (17 passed).
