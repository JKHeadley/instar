# Local Verify can run the test files most likely to fail first
<!-- bump: minor -->
## What Changed

A verify that fails says so late: a lane's failure is known only when the whole lane has ended, 25 to 40 minutes in on the Studio. Local Verify can now run a small first part of each lane before the rest, so a failure in a likely file shows a couple of minutes after the lanes start. It is off by default and set per machine.

- **The setting.** `monitoring.localVerify.likelyFailingFirst` is `off` (the default), `on` or `alternate`. Each run machine reads its own value at the start of each verify it runs. With it off, a verify runs exactly as before: the same commands and the same reports.
- **Three things happen whatever the setting,** so that the switch can be turned on for one machine at any time:
  - The coordinator keeps the likely-failing list up to date (`state/local-verify/likely-failing.json`, one `likely-failing-updated` audit row per change).
  - A verify record may carry one new optional field, `rerunCutOff`: the failed files whose second try was cut off because another lane had already failed. Only when there is such a file. The list leaves those files out.
  - The coordinator assigns each new pull request to the trial's "with" or "without" group when it is first queued, writing `state/local-verify/first-part-groups.json` and one `first-part-assigned` audit row. With the setting off nothing reads the assignment.
- **The first part.** For a verify of a pull request, each of the three lanes first runs:
  - the test files the change adds or edits,
  - the files the same change failed on in its previous verify,
  - the lane's files from a list of files that failed for other pull requests in the last 7 days.
  - Limits: 80 files in the unit lane; 20 in integration and 12 in end-to-end, each also held to 60 seconds of recorded time.
- **What a failure there does.** The existing rules are applied earlier, not changed. A failed file still gets its second try alone. If it still fails, the lane does not start the rest of its files, the existing fail-fast stops the other lanes, and the verify is recorded as failed. With fail-fast off, nothing ends early.
- **No test is removed.** A clean first part only lets the rest of the lane start. A pass is declared only after every test in the run has passed.
- **The list.** The coordinator updates it whenever it records a failed verify of a pull request, its own or one a peer ran. A file keeps one entry per pull request (its latest failure). It sends the list with each verify it hands to a peer. A lost or unreadable list is empty and rebuilds.
- **The trial setting.** In `alternate`, the coordinator assigns each pull request once to "with" or "without" first parts and keeps that for every later verify of it. A machine in `alternate` also checks itself: the first 5 verifies of each kind (ended in a first part, failed later, passed) are followed by one comparison run of the same code without first parts. A difference on a file that is not already known to be unreliable sets the switch to `off` on that machine and raises one notice.
- **Main verifies are unchanged.**
- **The verifier's version changes** with this build, as with any change to the lane flow. A coordinator and its peer must install it together: until both have, the coordinator hands the peer nothing.

## What to Tell Your User

Nothing changes until you turn it on. If you use Local Verify to test your own changes, I can now run the test files most likely to fail first, so a failing change is found in minutes instead of half an hour. Every test still runs before anything is called a pass. It is a setting per machine, and there is a trial mode that uses it for half of the pull requests and compares.

## Summary of New Capabilities

| Capability | How to use it |
|---|---|
| Run likely-failing test files first | Set `monitoring.localVerify.likelyFailingFirst` to `on` in `.instar/config.json` on a run machine |
| Trial on half of the pull requests, with a self-check | Set it to `alternate` |
| See the setting, the list and the trial counts | `GET /local-verify`, field `likelyFailingFirst` |
| Audit rows | `first-part` per verify, `likely-failing-updated`, `likely-failing-unreadable`, `first-part-compare`, `first-part-switched-off` in `logs/local-verify.jsonl` |

## Evidence

- **Unit, `tests/unit/localVerify/firstPart.test.ts`:** which files go first (order, per-lane limits by count and by recorded time, lane membership, overlapping paths entering together, wildcard paths left out), the setting, and the bounded request field (refused whole when malformed, omitted when empty, overlength paths left out).
- **Unit, `tests/unit/localVerify/likelyFailingList.test.ts`:** counting, ranking by different pull requests, ties, the 7-day window, the 500-file bound with its eviction, and the stale, oversized and unreadable cases against a real file.
- **Unit, `tests/unit/localVerify/firstPartFlow.test.ts`:** the real run function with a fake test runner that honours named files, `--exclude=` and `--shard=`. Every file reported once in each of the three ways the rest of a lane runs; a first-part failure that passes alone; one that still fails; more than 3 failures; the shared second-try budget; the lane deadline covering both parts; fail-fast off. Two properties over every combination of outcomes: a verify is recorded as passed only when every file of every lane ran and passed, and the verdict with first parts equals the verdict without.
- **Unit, `tests/unit/localVerify/firstPartTrial.test.ts` and `firstPartService.test.ts`:** one assignment per pull request across retries, new heads and a restart; the list updated by the one completion path; the list sent to a peer; the comparison run starting only after the verify is recorded, never changing the record, bounded to 5 per kind, and switching the setting off on a difference.
- **Unit, unchanged and green:** the existing `orchestrator`, `laneReport`, `shardPlan`, `inventory`, `LocalVerifyService`, `peerVerifier`, `record` and `mainHealth` test files.
- **Integration and end-to-end** (`tests/integration/local-verify-likely-failing-first-routes.test.ts`, `tests/e2e/local-verify-likely-failing-first-lifecycle.test.ts`): written; they run in the merge gate's own verify, not on the build machine.
- **Not yet shown live:** the feature ships off. The measured effect is what the two-week trial in the spec reports.
