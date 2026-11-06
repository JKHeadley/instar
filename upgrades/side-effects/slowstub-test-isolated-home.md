# Side-effects review: slow-stub tmux test runs its server with an empty home

**Tier:** 1 (test-only, one file, about 12 lines). Effort: no spec review rounds; 1 commit attempt.

## Summary
`tests/integration/tmux-resilience-slow-stub.test.ts` boots a real AgentServer without isolating HOME. AgentServer builds its TokenLedger over `path.join(os.homedir(), '.claude', 'projects')` and its poller scans it. On the Studio that is about 700 MB / 1,400 transcripts inside the 30-day window, so the scan held the worker's event loop while the timed route checks ran. Measured in the test worker's CPU profile: about 6 s of self time in `TokenLedger.ingestFile` and `ingestLine`; `/health` took 1.4-2.7 s per call; the check "sentinel-style running-session enumeration ... cannot starve health" (limit 1000 ms) failed 3/3 on main 79d83ec93 and 3/3 on #2825 5545b7d56. The fix sets `process.env.HOME` to the suite's own temp dir for the route block's server and restores it after, the same pattern as `resume-heartbeat-health-concurrency.test.ts` and `memory-privacy-spawn.test.ts`. After: 5/5 pass, and 3/3 with 12 extra busy loops.

## 1. Over-block
None. Only the test's environment changes.
## 2. Under-block
The checks still measure the same routes against the same limits; they no longer also measure the host's transcript history. The production observation stands on its own: a large transcript history makes the first TokenLedger scans hold the event loop for seconds, even with maxFilesPerScan 500 and yields every 25 files. That is outside this test repair and goes to the feedback queue.
## 3. Level-of-abstraction fit
Right layer: the defect is the test using the host's home.
## 4. Signal vs authority
No decision point. Test code only.
## 5. Interactions
HOME is process-wide within the test worker. It is set in the route block's beforeAll and restored in its afterAll; the other blocks in the file build no AgentServer and read nothing from HOME. Vitest runs files in separate workers.
## 6. External surfaces
None. Tests do not ship to agents.
## 7. Multi-machine posture
Not applicable. Test-only, nothing runs on agents.
## 8. Rollback cost
A revert of one test file.
