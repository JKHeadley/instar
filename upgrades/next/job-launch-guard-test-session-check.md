<!-- bump: patch -->
<!-- internal-only -->
## What Changed

Test only. The last case in `tests/e2e/job-launch-lifecycle.test.ts` (added on 2026-11-16 to prove the scheduler's memory gate still refuses a job) asserted that the mock binary's call log held exactly one launch line. The mock logs every call it receives, and on a loaded machine a second call from the first job landed in that log, so the case failed on a correct product (Local Verify run of PR 3227 on the Mac Studio, 2026-11-16T11:54Z: two launch lines, neither from the refused job). The case now asks tmux whether a session exists for the refused job's own slug. The other assertions of the case are unchanged: the 409 refusal, the single `memory-pressure` skip record, the skip event text and the absence of a run row.

## Evidence

- The failing run: Studio run-detail for PR 3227, `tests/e2e/job-launch-lifecycle.test.ts`, "a refused job must not launch a process: expected [ '--launch--', '--launch--' ] to have a length of 1 but got 2".
- `tsc --noEmit` clean for the file. The file is run by Local Verify on this change.
