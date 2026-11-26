# Release-fragment admission check

Two full runs could not lead to a merge because the release-fragment check had already failed. Local Verify now refuses source changes missing a Markdown fragment under upgrades/next before admitting them. It uses the GitHub PR file list and confirms the head and target after fetching additional pages. The release workflow retains its own checks and decisions.

Already running attempts are allowed to finish. An operator can offer a new head once the fragment is present. To roll back the admission change, revert this commit and deploy through the guarded restart. Do not hand-publish statuses for an unverified successor.

## Second-pass review

**Reviewer:** independent second-pass reviewer (Claude Fable 5.2 helper for the Echo Chief of Staff session), not the author

Concur for the source at head `dd34b5e004e56dfcc1c6f1d92663364e974c3788`. I read the full diff and the surrounding code of the four files that flag this change as harness-changing (`src/localVerify/LocalVerifyService.ts`, `src/localVerify/localVerifyRoutes.ts`, `src/localVerify/serviceSeams.ts`, `src/localVerify/waitingList.ts`) and the six changed test files. I did not rerun any tests; the full Local Verify run on that head is the test evidence. The only later change is a wording fix to the release note, which is not a flagged file.

- **No check is weakened.** The change only adds a refusal before admission. Nothing in the run, the verdict, the record, the status projection or the merge path is touched, and no check can now pass with less evidence. The test edits add a fragment to fixtures so those tests still reach the behaviour they assert; no assertion is removed or loosened and no skip or timeout is added.
- **It does what it says.** `request()` refuses with `release-fragment-missing` after the closed and trust checks, and queue restoration drops such an entry; both write an audit event. The route maps the code to 409. The PR view now reads every page of the file list when the first page is full and re-confirms head and base, returning unreadable on any doubt.
- **No newly silent failure.** Every new failure branch in the PR view returns null, which the service already answers as `pr-unreadable` (a refusal, never an admission).

Non-blocking notes: the local rule is not identical to the GitHub check (a change to a test file under `src/` counts as a source change here, and only files under `upgrades/next/` count as a fragment), so a rare PR GitHub would accept is refused until it adds a fragment; a PR with 3000 or more changed files is now always unreadable to Local Verify; the PR view now returns unreadable where it previously tolerated a malformed file entry; the queue entry removed on a refusal is not given its own `dequeued` audit line (the `refused` line is written).
