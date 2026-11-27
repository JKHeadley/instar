# Side-effects review

## Scope

This small, reversible change extends the existing private failed-run report with unit-process diagnostics. A unit process can fail after reporting no failed tests when its worker or process errors outside the tests.

## Signal and authority

The diagnostic carries the process result and the bounded output the runner already holds. It is written through the existing private artifact path. Verdict evaluation, lane cancellation, merge rules, and retention use the same authority as before. A capture or write error leaves the test verdict intact.

## Impact and rollback

Diagnostic output stays on the machine in the retained failed checkout. The report keeps the existing 64 KiB cap and discloses omissions. Old artifacts remain readable. Reverting the change stops new process diagnostics without a migration or cleanup operation.

## Evidence

The focused failure-evidence and orchestrator suites passed 150 tests. The test runtime reported an unavailable better-sqlite3 binding during setup. The focused suites completed successfully. The new regression checks a unit exit of 1 with no failing test entries and confirms that the existing retained artifact includes the stderr diagnostic.

## Second-pass review

Reviewer: /root/unit_exit_review. The reviewer concurred after the reporter summary was parsed structurally and process evidence could replace lower-priority assertion text within the cap. The final follow-up checks process-only capacity before evicting any assertions.
