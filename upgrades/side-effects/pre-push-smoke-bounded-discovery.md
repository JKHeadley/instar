# Bounded pre-push smoke discovery

For known shared inputs, run the directly changed test files that fit the local smoke budget and report that related coverage is deferred to CI. Narrow source changes retain Vitest related discovery. Their bounded file list is reused for test case collection and execution. If discovery or collection fails, the local check still reports failure or an indeterminate selection.

The local check is a development signal. It does not change protected paths, required hosted checks, full-suite verification or merge authority. There are no persisted state or configuration changes. Reverting restores the prior local discovery and execution behavior.

The direct path uses committed branch changes from the merge base. Staged and unstaged edits and untracked files do not expand that path. Vitest related discovery for narrow source changes retains its existing working-tree behavior. Directly changed E2E files are reported as deferred to the CI E2E job. The push config still controls exclusions and the log reports when it selects zero test cases.

## Second-pass review

**Reviewer:** Pipeline Strategy (echo-pipeline-strategy) and the Chief of Staff's standing independent reviewer.

Both returned CONCUR on content tree 89de1cec with no blockers. Pipeline Strategy verified that the original code stayed unchanged in commit 35213165.

- Pipeline Strategy review: `.instar/state/handoffs/reviews/second-pass/echo-pipeline-strategy-act-558-pre-review-ea9cf46b.md`
- Standing review: `.instar/state/handoffs/reviews/act-558-89de1cec-review.md`
