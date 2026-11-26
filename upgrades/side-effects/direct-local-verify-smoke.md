# Local Verify direct smoke selection

The local push hook can use a bounded sample for a clean checkout of a Local Verify change. It intersects the Vitest inventory with tracked files and uses direct imports plus required changed, wiring and registry tests. It falls back to transitive selection outside the declared scope or when the sample cannot be supported. An invalid inventory, a mismatch in execution, or a skipped required file cannot present a green result.

The 21-file named retry selected 1,084 files through the old transitive path. The direct scan took about three seconds and found 60 files. Exact collection took 35.5 seconds and produced 1,402 cases. The case budget kept 1,000 cases in 38 files, including the mandatory tests. Shared verification still runs its full inventory and has sole merge authority.

Rollback is a code revert to the existing transitive selector. The smoke runner retains the previous behavior for every change outside the scoped diagnostic and maintains the existing test budgets.

## Second-pass review

**Reviewer:** peer_gate_design_review, independent source review.

Concur. Direct smoke filters to tracked tests from a clean worktree, reconciles exact files and case counts on both executions, and requires that mandatory files run assertions. Existing caps, fallback and shared verdict authority are retained.

The hook reports listing mode, elapsed time, candidate count and selected files and cases. The report is emitted before starting tests, so test execution time does not inflate discovery timing. The report is for operators and does not participate in verdict decisions.
