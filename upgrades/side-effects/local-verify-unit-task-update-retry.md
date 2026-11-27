# Side-effects review for the unit task-update timeout retry

## Summary

Tier 1. This is a reversible recovery change inside the existing verifier. It reads the installed reporter output and retries one eligible unit process. It adds no merge authority or configuration. The first commit attempt identified the missing review trace. The focused orchestrator, parser and reporter checks passed 212 tests, and the native TypeScript check passed.

## Over-block and under-block

An unknown reporter version, incomplete inventory, bounded error list with omitted messages, or split unit run stays on its existing path. These cases may still report infrastructure failure. The known timeout is matched exactly. Clean results from a retry require complete reports and matching per-file counts. A retry with a failed test cannot give a passing verdict through file isolation.

## Level of abstraction and signal versus authority

The reporter parser supplies a signal about a known tool error. The existing orchestrator owns process budgets and recovery. The existing verdict evaluator and coordinator own the final result and admission. The retry itself changes no operator or merge controls. The retry condition is an enumerable report format and error class.

## Interactions

The retry uses a different report name and the same lane deadline and suite slot. It runs at most once. The separate report paths prevent the two attempts from overwriting each other. An abort from a sibling lane still cancels the retry. When a retry ends with failed assertions, the original unhandled error remains in the evidence so a solo rerun cannot substitute for a passing full retry.

## External surfaces

The machine may spend the remainder of an existing unit deadline on a retry. The runner emits both attempt outcomes, and a kept failure retains process receipts. There is no operator action, external request, migration, or change to which receipts the coordinator trusts.

## Rollback

Revert the commit and update the verifier through the existing release process. There is no persisted state to migrate or repair.

## Independent review

The independent reviewer found that the initial version could let an assertion failure on the full retry reach file isolation. The implementation now preserves the original unhandled error and retains the assertion failure. The reviewer verified the correction and concurred.

## Second-pass review

**Reviewer:** independent second-pass reviewer, Claude Fable 5.2 helper for the Echo Chief of Staff session, not the author

Concur for head `fed99727eaee7f67d8ee7ca00919a343a269daf1`. I read the full diff of the three files that flag this change as harness-changing (`src/localVerify/laneReport.ts`, `src/localVerify/orchestrator.ts`, `src/localVerify/unhandledErrorsReporter.ts`), the lane runner around the new block (the process step, the isolation re-run phase, the two-part lane path and the final evaluation), the added tests, and the installed test runner's own report and timeout-message code. I did not rerun any tests; the full Local Verify run on this head is the test evidence. The section above titled "Independent review" is the author's account, not mine.

- **The retry fires only on the narrow case.** It needs all of: the unit lane, run as one process with no first part and no borrowed helper; exit code 1 with no signal; an error file of version 1 whose one to five messages are every one the exact task-update timeout text and whose count equals the number of messages (six or more errors, or any other message, do not qualify); a report whose summary says success with zero failed, pending-suite and failed-test counts and whose totals equal the per-file counts; every inventoried unit file present with zero failures and no failure message; lanes not stopped and lane time left. Anything else stays on the path that existed before.
- **It is bounded to one and cannot make a failing tree pass.** There is no loop, and the retry's own result is never fed back into the trigger. The retry is accepted only when it exits 0, reports zero unhandled errors with an empty message list, and its report is complete, clean and matches the first run file by file. That is a full unit run that would count as passing by itself, so a real assertion failure on a pull request or on main cannot be turned into a pass.
- **A repeat is neither a pass nor an assertion failure.** If the retry is not accepted and has no failed test, the lane keeps the first run's result (exit 1, unhandled errors counted), which fails as before with no failed file named. If the retry has a failed test, that failure is kept together with the first run's unhandled errors, so the isolation re-run cannot clear it (tested). An aborted retry ends the lane as stopped early.
- **Both attempts leave receipts.** They write to separate report and error files, both attempts are logged with their counts, and on a failed run the kept evidence holds both process entries (tested). No existing test is changed or removed; five test registrations covering eleven scenarios are added.

Non-blocking notes: the retry runs inside what is left of the 40-minute unit deadline, so a first run that used most of it leads to a deadline on the retry, which ends the run as an error and stops the other lanes where it previously ended as a failure (still never a pass, but it can hold the test slot for up to the rest of the deadline); a passing record reached through a retry carries no marker of it, only the run log does; the trigger does not apply when the unit lane runs in two parts or with a counting helper, when a suite is marked todo, or when a lost update leaves a test in the running state, so it may fire less often than hoped; the deadline-during-retry and signal-exit paths have no dedicated test.
