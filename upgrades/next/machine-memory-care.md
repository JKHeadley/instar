# Swap counts in machine health, a machine short of memory leaves the test line, and test runs clean up after themselves

<!-- bump: patch -->

## What Changed

Machine health (`src/core/machineLoadReport.ts`) now reads swap: bytes in use, and whether the machine is still paging out at a sustained rate (at least 1 MiB/s). Swap above 10% of physical memory counts as memory pressure when there is live evidence: the machine is paging, has under 15% of memory available, or the OS reports pressure. Swap of 25% of memory or more, while still paging, makes the machine `impaired`. Leftover swap on a machine that is no longer paging does not count. Each load report in `GET /pool` carries `swapUsedBytes`, `swapActive` and `memoryPressured`. A report from older code reads exactly as before.

Local Verify (instar source agents) keeps a memory-pressured machine out of the test line by itself:
- The coordinator stops starting tests of its own, and still hands work to healthy peers. During a long hold it runs one test every 45 minutes, so merging never stops completely.
- The coordinator skips a peer whose report says it is short of memory.
- A peer refuses hand-offs while it is short of memory.
- One attention item per machine per episode. It closes after 10 minutes of normal readings.

Every verify run now ends the test processes it left behind, such as detached tmux servers and stopped workers. A backstop at boot and every 10 minutes clears older ones: orphaned processes of this user that point into Local Verify's own folders. In the shared temp folders, only processes older than 6 hours are cleared.

Spec: `docs/specs/machine-memory-care.md`.

## What to Tell Your User

A test machine that runs low on memory now steps out of testing by itself and you get one notice saying which machine and why. Test runs also clean up the background helpers they used to leave running, which had piled up to 6.6 GB on the M5.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Swap and memory pressure in every machine's health report | `GET /pool` → `machines[].loadReport.swapUsedBytes`, `swapActive`, `memoryPressured` |
| A memory-pressured machine leaves the Local Verify test line, with a notice | Automatic; attention item `local-verify:memory-pressure:<machineId>` |
| Local Verify ends its own leftover test processes | Automatic; audit `leftovers-reaped` in `logs/local-verify.jsonl` |

## Evidence

On 2026-11-14 the M5 had 17 of 18 GB of swap in use and 66 leftover Local Verify processes (6.6 GB, up to 18 days old), and Justin restarted it by hand (topic 130715, 22:06Z). The Mac Studio had 6 leftover e2e tmux servers and shells, up to 3 days old, at the time of writing.

Tests:
- `tests/unit/machine-load-report.test.ts`: the M5 case reads `impaired`; leftover swap at a healthy Mac's ~25% available reads `ok`; a trickle below 1 MiB/s is not paging.
- `tests/unit/localVerify/leftoverReaper.test.ts`: orphans only; a session whose prompt names a run path is never taken; tmux is matched only by its socket.
- `tests/unit/localVerify/machineMemoryCare.test.ts`: the hold, the one-start window, the notice lifecycle, the peer skip and refusal.
- `tests/integration/localVerify/leftoverReaper.real.test.ts`: a real stopped process and a real detached tmux server are ended; a look-alike outside the folder survives.
- The e2e lifecycle tests: real swap numbers in `GET /pool`, and the production wiring runs the boot sweep through the real reaper.
