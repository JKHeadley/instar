# Bounded pre-push smoke discovery

For known shared inputs, run the directly changed test files that fit the local smoke budget and report that related coverage is deferred to CI. Narrow source changes retain Vitest related discovery. Their bounded file list is reused for test case collection and execution. If discovery or collection fails, the local check still reports failure or an indeterminate selection.

The local check is a development signal. It does not change protected paths, required hosted checks, full-suite verification or merge authority. There are no persisted state or configuration changes. Reverting restores the prior local discovery and execution behavior.

The direct path uses committed branch changes from the merge base. Staged and unstaged edits and untracked files do not expand that path. Vitest related discovery for narrow source changes retains its existing working-tree behavior. Directly changed E2E files are reported as deferred to the CI E2E job. The push config still controls exclusions and the log reports when it selects zero test cases.
