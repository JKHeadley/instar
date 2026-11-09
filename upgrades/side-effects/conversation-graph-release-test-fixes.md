# Side-effects: three test files on the Conversations release branch pass from a clean checkout

## Summary

Test-only change. No file under `src/` changes.

The full-suite run on the M5 found two problems in tests on the Conversations release branch:

1. `tests/integration/team-access-status-table.test.ts` builds one sample path for every route in the phone allowlist. Its generator turned every character class into one `x`, whatever the quantifier, and it read nested groups in one pass only. Two new graph routes could not be sampled: erasure status (`[A-Za-z0-9_-]{8,160}` needs at least 8 characters) and change cancel (a group that holds groups). The generator now writes as many `x`s as the quantifier's minimum and reads groups innermost first until none is left. The routes stay in the table and are checked like every other route; nothing is excluded.
2. `tests/integration/graph-default-peers.test.ts` and `tests/integration/graph-owned-controller-framing.test.ts` wrote phase logs and evidence files into the repository's `.instar/state/build`, a folder that is git-ignored and only exists on the Studio. On any other checkout the write failed with ENOENT. They now write into temporary folders. In `graph-default-peers` the folder lives for the whole file and is deleted in `afterAll`, because one test wraps the runtime prototype's `close` and never unwraps it, so later tests in the file still append to its phase log (a per-test folder made three later tests fail with ENOENT). In `graph-owned-controller-framing` the folder is per test and the shared graph fixture deletes it.

## 1. Over-block
None. The status-table test now checks two more routes than before; it does not refuse anything new.

## 2. Under-block
None. No assertion was removed or loosened. The phase logs and evidence files were written for debugging and were never read back by any test or script.

## 3. Level-of-abstraction fit
The sample fix is in the test's own path generator, which the file's header says is meant to cover any route added later. The temp folder uses the fixture's existing cleanup list.

## 4. Signal vs authority compliance
Not applicable: test-only, no runtime decision changes.

## 5. Interactions
Routes that sampled correctly before still sample to a matching path. A route that earlier fell back to a hand-written path in the test's `NAMED` list may now get a generated path instead; the table then checks the generated one.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable. The point of item 2 is that the tests now run the same on every machine.

## 8. Rollback cost
Revert the commit.

## Class-Closure Declaration
Defect class: test-environment dependency (tests writing into a machine-local, ignored folder). Closure: partial. Other graph tests still write into `.instar/state/build` and are named in the commit report for a follow-up.

## Evidence
- Focused runs on the Studio of the four affected integration files.
- A run of the two graph files from a fresh `git worktree add` of this commit, with no `.instar/state/build` folder.

## Second-pass review
Not required: test-only change.
