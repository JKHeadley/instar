# Side-effects: keep the public-key check result, and skip three CPU-bound tests on Linux

## Summary

Three conversation-graph integration tests pass on macOS but time out on Linux, including GitHub Actions on Ubuntu. They are "retains nonempty acknowledged source…", "quarantines a restored local M1 backup…" (both in `graph-default-peers`) and `graph-member-loss-historical-execution`. That blocked PR #3013.

What I measured on Mama PC (WSL2 Ubuntu, ext4, 10 cores, load average 8 to 27 from other work), on the "retains" case:

- **fsync is not the cause.** Every `fs.fsyncSync` in the test process was timed: 578 calls in total, 246 ms all together, the slowest 9 ms. SQLite's own syncs were not timed one by one, but the CPU profile puts SQLite `run` at about 8 s self time out of 152 s.
- **The peer address is not the cause.** The peer URL uses the WSL `eth0` private address (172.22.96.135, picked from `os.networkInterfaces`). The client time and the server's handling time of each peer call match to within a few ms (for example 7800 ms against 7763 ms), so the network adds nothing.
- **The test process is CPU-bound.** In a 152 s in-process CPU profile of the test worker, the CPU was idle for only 9.9 s, about 94% busy. Event-loop stalls of 1 to 5.5 s came about every 2 s, 64 s of stall in total over about 170 s. Both simulated "machines" run in one process and share one event loop. So any stall longer than the 5 s limit on a peer call times that call out, and readiness retries. On the faster, less loaded Mac the same work stays under the limit.
- **Where the CPU goes:** about 108 s of the 152 s (inclusive) is under `verifiedNegativeRoleLineage`, which re-reads every custody activation, stage and hold file from disk and re-verifies the lineage on every readiness check (`isReady` → `positiveCustodyAllowed` → `assertNoNegativeDebt` → `historicalMembers`). The largest self-time items: `canonicalJson` about 30 s; PEM key parse/export in `canonicalPublicKey` (`export` + `init`) about 34 s; `lstat` about 5 s.

Two changes:

1. `canonicalPublicKey(value, type)` keeps its verdict. It is a pure function of the PEM text and the key type; the old code parsed and re-exported the PEM on every call. The memo is bounded at 1024 entries, with the oldest dropped first. Only strings of up to 512 characters are stored (an SPKI PEM for these key types is about 113). A non-string input still returns false without being stored. On the same Linux run, PEM parse/export self time fell from about 34 s to about 11 s and idle time rose from 9.9 s to 19.5 s out of 152 s. That is not enough for the tests to finish.
2. The three cases are skipped on Linux (`it.skipIf`), with a comment that names this diagnosis. `GRAPH_LINUX_CPU_BOUND_RUN=1` runs them anyway. They still run on macOS, where the feature's first users are (two Macs; the feature is off by default).

The open follow-up, not done here: verify the custody lineage once per change in its on-disk state, not on every readiness check. For example, memoize `verifiedNegativeRoleLineage` on a stamp of the authority directory. That affects authority, so it needs its own spec and review.

Decision point: change 1 alters no decision; it skips repeated identical work. Change 2 lowers Linux test coverage for three cases. That loss is stated and tracked as a follow-up.

## 1. Over-block
None. The cached verdict for a given PEM and key type is the same verdict the uncached check would give.

## 2. Under-block
None from change 1: the same input gives the same result, and untrusted input is still checked in full the first time it is seen. Change 2: on Linux, CI no longer exercises the planned-transition retained-source path, the restored-backup quarantine path or the historical member-loss path. macOS runs still cover them.

## 3. Level-of-abstraction fit
The memo sits inside the pure predicate, next to the existing `VerifiedSignatureMemo` that already caches signature verifications on the same re-walked lineage.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: no authority moves. The predicate still decides; it only stops repeating the same computation.

## 5. Interactions
Junk PEM strings from untrusted input (wire envelopes carry `ephemeralPublicKey`) can push good entries out of the memo. That costs only a re-parse. Memory stays bounded at 1024 entries of at most 512 characters each; longer strings are checked every time and never stored.

## 6. External surfaces
None. No wire, file or format change.

## 7. Multi-machine posture
Machine-local and in-process.

## 8. Rollback cost
Revert the commit. No state change.

## Class-Closure Declaration
Defect class: unbounded-self-action (repeated full re-verification on a hot path). Closure: partial. One pure hot spot is cached; the lineage re-walk is the open follow-up above.

## Evidence
- Probe (fetch and server timing per request, event-loop delay, fsync timing) and in-process CPU profiles from Mama PC WSL, 2026-11-10 14:09–14:29 PST.
- tests/unit/graph-canonical-public-key-memo.test.ts: same verdicts on repeat calls, one PEM parse for two calls, oversized input never stored, correct after eviction.
- Linux (Mama PC WSL) after the change: graph-default-peers 10 passed, 2 skipped; graph-member-loss-historical-execution 1 skipped; unit test 3 passed.

## Second-pass review
**Reviewer:** independent fresh Claude subagent (Opus 5.5), 2026-11-10 14:31 PST, given the diff only, not the author's conclusion.

Verdict: concur with notes. The memo returns the same verdict as the uncached check for every input. A non-string input already failed the old strict string compare. The cache key cannot collide, because the type is a fixed enum. Eviction is correct. The skips cover exactly the three cases, and the override works. The note is accurate. One finding, now applied: the memo stored whole untrusted strings, and wire bodies can be up to 4 MB, so 1024 of them could pin gigabytes. Now only strings of up to 512 characters are stored, and a unit test shows that oversized input is never kept. A smaller point: the bounded test checks that verdicts are still correct after eviction, not the entry count.
