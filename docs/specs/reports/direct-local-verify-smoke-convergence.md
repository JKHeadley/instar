# Direct Local Verify smoke review

An independent source reviewer identified gaps in clean-worktree coverage, tracked test selection, and focused retry evidence. The implementation now checks all nonignored worktree changes, uses the Git tracked test inventory, and requires complete file and per-file case counts at both executions. Required and retried files must have at least one passing or failing test outcome. The reviewer concurred with the revised implementation.

Two cross-model reviews asked for explicit scope and test paths, separate inventories for discovery and execution, a stable cap policy, and a clear meaning for test execution. The spec now states those decisions. A focused entry-point test refuses a retry that exits zero without reporting the failed file. The test count guard rejects a swapped per-file count even when the total stays the same.

The matched 21-file change went from 1,084 transitive files to 60 candidates in about three seconds. Exact collection took 35.5 seconds and found 1,402 cases. The bounded sample was 38 files and 1,000 cases. Shared verification and its merge authority remain in place.
