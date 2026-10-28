# Make feedback fixes prove that their named test actually ran

Echo's automatic feedback fixer asks a build session to add a regression test, fix the bug, and report the test's name. Trusted code then runs that named test on the original code and on the proposed fix. The original must fail for the right reason and the proposed fix must pass before a pull request can be opened.

The latest live attempts exposed a gap in that proof. A build session supplied a test name that selected no tests. Vitest exited successfully while saying all 33 tests in the file were skipped. The original-code check rejected the attempt, but reported the misleading reason “test passes at base.” The proposed-fix check would have accepted the same empty run as a pass if it reached that stage. Both attempts stopped before a pull request, so no unproved change was published.

This change teaches the existing proof gate to read Vitest's test summary. A successful process with no passed tests is classified as “test not found” on the original code and rejected as “test not run” on the proposed fix. The build session's task text also asks it to run the exact name it writes in its result file and confirm that Vitest ran at least one test. The separate base, head, lint, review, and owner gates remain in place.

The release decision is whether this narrow proof correction is ready. It may reject an unusual Vitest output format whose summary cannot be read, which is safer than publishing a fix without a running regression test. A revert restores the old behavior. Focused service tests cover both empty-run branches and a normal passing test; the existing HTTP and production lifecycle suites must stay green.
