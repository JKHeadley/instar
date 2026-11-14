# Side-effects: Conversations tests write their evidence to temporary folders, so they pass from a clean checkout

## Summary

Test-only change. No file under `src/` changes.

The full-suite run on the M5 found problems in tests on the Conversations release branch:

1. `tests/integration/team-access-status-table.test.ts` builds one sample path for every route in the phone allowlist. Its generator turned every character class into one `x`, whatever the quantifier, and it read nested groups in one pass only. Two new graph routes could not be sampled: erasure status (`[A-Za-z0-9_-]{8,160}` needs at least 8 characters) and change cancel (a group that holds groups). The generator now writes as many `x`s as the quantifier's minimum and reads groups innermost first until none is left. The routes stay in the table and are checked like every other route; nothing is excluded.
2. Graph tests wrote phase logs, wire captures and proof reports into the repository's git-ignored `.instar/state/build`, a folder that only exists on a machine that has run /build. `graph-default-peers` and `graph-owned-controller-framing` failed with ENOENT on any other checkout. The others created the folder first, so they passed, but they left files inside the repository. Every such write under `tests/` now goes through one helper, `tests/helpers/test-evidence-dir.ts`. It gives each test file one temporary folder and removes it after the file's last test. Setting `INSTAR_TEST_EVIDENCE_DIR` writes to that folder instead and keeps it, for opt-in proof runs whose reports someone wants to read. Files: `graph-default-peers`, `graph-owned-controller-framing`, `conversation-graph-owner-changes`, `graph-member-loss-historical-execution`, `graph-ordinary-pin-private-view`, the e2e files `conversation-graph-normal-cli-owned-boot`, `conversation-graph-live-fixture` and `conversation-graph-surface-alive`, the unit scale proof `graph-native-tail-max-member-paged-proof`, and the helpers `graph-default-owned-source-http-proof` and `graph-member-loss-production-entry`.
3. `graph-default-peers` wrapped two shared prototypes (`GraphWitnessClient` operation/recover/inventory and the replication runtime's `close`) to log phases and never unwrapped them. The wrappers stacked on each of the three tests that use them and stayed for the rest of the file. (A first attempt with a per-test folder made three later tests fail with ENOENT because of this.) Each wrap now records its undo, and an `afterEach` undoes them.

## 1. Over-block
None. The status-table test now checks two more routes than before; it does not refuse anything new.

## 2. Under-block
None. No assertion was removed or loosened. The phase logs and evidence files were written for debugging and were never read back by any test or script.

## 3. Level-of-abstraction fit
The sample fix is in the test's own path generator, which the file's header says is meant to cover any route added later. One helper owns where test evidence goes, so a new test has no reason to name `.instar/state/build` again.

## 4. Signal vs authority compliance
Not applicable: test-only, no runtime decision changes.

## 5. Interactions
Routes that sampled correctly before still sample to a matching path. The evidence folder lives for the whole test file, so a fixture closing after its test can still write to it. A route that earlier fell back to a hand-written path in the test's `NAMED` list may now get a generated path instead; the table then checks the generated one.

## 6. External surfaces
None.

## 7. Multi-machine posture
Not applicable. The point of item 2 is that the tests now run the same on every machine.

## 8. Rollback cost
Revert the commit.

## Class-Closure Declaration
Defect class: test-environment dependency (tests writing into a machine-local, ignored folder). Closure: complete for `tests/`. No test writes into the repository's `.instar/state/build` now; the `/build` skill's own tests use that path inside their own temporary folders, which is correct.

## Evidence
- Focused runs on the Studio of the four affected integration files.
- Runs of the affected files from a fresh `git worktree add` of this commit, with no `.instar/state/build` folder, including the opt-in diagnostic observers.

## Second-pass review
Not required: test-only change.
