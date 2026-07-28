# ELI16: Pre-push Smoke Failed-Files Retry

The pre-push smoke check is supposed to be a quick local warning before a branch is pushed. It is not the final judge. The pull request CI still runs the real test matrix before code can merge.

The previous fix made the smoke check choose the right base branch and skip local smoke when the selected set is too broad. That solved the worst case where an agent worktree compared against a stale remote and tried to run a near-whole-suite check locally.

This change handles the next wasteful case: a normal smoke run can still select a meaningful group of tests. If one file fails, the current hook repeats the whole selected group. That means a single flaky or isolated failure can make the local hook pay for every selected test twice.

The new behavior keeps the first run exactly as useful as before. Vitest still prints its normal output, and the smoke runner still runs the affected set selected by `--changed`. The only addition is that the runner also asks Vitest to write a JSON results file. If the first run passes, nothing else happens.

If the first run fails, the runner reads that JSON file, finds the test files that actually failed, and runs only those files one more time. It prints the list so the developer or agent can see exactly what is being retried. If the JSON file is missing, malformed, or does not name any failed files, the runner does not guess and does not pass the hook. It keeps the original failure.

This keeps the local retry useful without letting it become another long broad-set run. The full push-suite option still keeps its old whole-command retry, because that path deliberately asks for the slower local suite. CI remains the authority either way.
