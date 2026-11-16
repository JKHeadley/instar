<!-- bump: patch -->
<!-- internal-only -->
## What Changed

Tests only. Two end-to-end job tests failed on a correct product depending on the machine they ran on (2026-11-16, four Local Verify runs on a loaded Mac Studio; the same heads passed on a second machine).

- `tests/e2e/job-launch-lifecycle.test.ts`: the server always wraps `scheduler.canRunJob` with the memory gate, and the gate reads the real host. On a machine at 75% memory use or more, every trigger in the file was refused ("Job admission refused by live scheduler"). The test now pins the gate's limits through the agent's own `state/memory-thresholds.json` (the file the monitor loads at boot), so the host's reading decides nothing. A new last test moves the limit below any reading and asserts the refusal, its `memory-pressure` skip record, no run row and no launched process, so the gate is still proven on the same production boot.
- `tests/e2e/job-cost-lifecycle.test.ts`: one scenario called `start()` on a scheduler holding the 26 built-in jobs, which arms real wall-clock crons; a five-minute tick landing inside the test spawned a session on the mock and broke its exact counts (`expected 1 to be +0`). The scenario triggers jobs directly and does not need a started scheduler, so it no longer starts one and asserts that.

No product code changes. Found and not changed here: `monitoring.memoryMonitoring: false` is not read where the memory gate is wired (`src/commands/server.ts`), so that setting does not turn the gate off.

## Evidence

- Unmodified `job-launch-lifecycle` reproduced the failure 3 of 5 tests on a host Instar read at 83% used.
- Each fixed file: 3 of 3 passes at 83% used and 3 of 3 at 61% used.
- Analysis with the refusal path line by line: the builder report for this change (agent home, `reports/throughput-improvement/2026-11-16-e2e-host-memory.md`).
