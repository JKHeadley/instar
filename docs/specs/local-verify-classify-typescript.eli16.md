# Local Verify: the test-parser bug, in plain words

## What this change is

Local Verify is the system that runs the full test suite on a pull request on this machine before the PR can merge. Part of its job is to look at each changed test file and count whether the PR added any `skip` calls or deleted any tests, so nobody can quietly turn tests off. To count those it needs a code parser called `typescript`.

That parser is a development-only package. The server that runs Local Verify is installed from the published package, which does not include development-only packages. So every time a PR changed any test file, the parser failed to load. The code treated any failure in that step as "I could not read this PR at all" and marked the PR as **harness-changing** — the label for a PR that changes the test machinery itself. That label makes the PR wait for an extra independent review it never needed. Twenty-three of the last forty-one verify runs were mislabelled this way.

## What already exists

- The verify run already installs the PR's own dependencies into a private copy of the code (`npm ci`) before running the tests. That copy has the parser in it.
- The spec already says a PR that changes the `typescript` version is itself harness-changing, so the parser version is never something a PR can swap in quietly.
- The merge rules already treat "skips added" and "tests removed" as flags that need an independent review covering the test files.

## What is new

1. The parser is now loaded from the PR's own installed copy first, then from the server's install as a fallback. Code that calls the orchestrator can also hand it a parser directly, which is how the tests exercise both outcomes.
2. If the parser still cannot load, that is no longer called "harness-changing". Instead the record says what could not be ruled out: "skips added" and "tests removed", but only when a counted test file actually changed. If the PR touched no counted test file, nothing is flagged. A real failure to read the PR's diff still marks it harness-changing, exactly as before.

3. A second bug, found when this very change was verified: the independent-review check added yesterday asks git "which commit last touched this review file?" through a safety funnel that only lets the verifier run a fixed list of git commands inside its own clone. `log` was not on that list, so the funnel refused the question and every reviewed PR was told "review not found". `log` (a read-only command) is now on the list. Nothing that can write is added.

## Safeguards, in plain terms

- Failing still fails closed. A parser problem produces a flag that needs a review; it never lets a PR through unexamined.
- The harness check itself is a separate step and is untouched; a PR that edits the merge tool or the test setup is still harness-changing.
- Nothing is removed from the merge rules; only the wrong label is corrected.

## What you need to decide

Nothing. These are two bug fixes with tests on both sides (parser missing, parser injected, no counted test changed). It can be reverted by reverting one commit.
