# Side-effects review

Tier 1. The change is a small, reversible diagnostic in the release workflow. With the repository variable unset, the wrapper immediately hands control to the original npm command. When enabled, it keeps the command output visible and uses a private temporary file to check the error. It returns npm's exit status and deletes the temporary file.

The hint grants no authority and starts no job. The existing workflow condition and npm credential input are carried forward. The message links to the existing development release instructions. It is emitted once and remains in the existing workflow log. No agent config, stored state, installer, or migration changes.

Three November 8 publish runs showed the same npm code and account suspension response. Tests simulate this response, unrelated errors, and a successful publish. They also verify the exact command is invoked once. Roll back by clearing the repository variable or reverting the change.

## Second-pass review

**Reviewer:** independent second-pass reviewer, Claude Fable 5.2 helper for the Echo Chief of Staff session, not the author

Concur for head `05343d0cd866a1906276b17d7d6e68ac11661803`. I read the full diff and the publish job around the changed step. The path that flags this change is `.github/workflows/publish.yml`; I also read `scripts/publish-npm-release.sh` and both test files, because the workflow step now delegates to that script. I did not rerun any tests; the full Local Verify run on this head is the test evidence.

- **It does what it says and nothing else.** The workflow change is one step: the publish command moves into the wrapper and one repository variable is passed in. The step's condition and the npm credential input are unchanged. With the variable unset or anything other than `true`, the wrapper replaces itself with the original `npm publish --provenance --access public`, so the exit status and output are those of the original step.
- **No check is weakened.** The edited assertion in `tests/unit/release-install-retry.test.ts` used to pin the exact publish command, which was how "never retries npm publish" was held. It now pins the wrapper path, and the new test holds the same guarantee one level down: in all six cases, including the failing ones, the stand-in npm records exactly one `publish --provenance --access public` call. No skip, raised timeout, or removed test.
- **Failure stays loud.** With the hint on, npm's own status is taken from the pipeline and returned, so a failed publish still fails the step and the later steps do not run. A failure of the temporary file, of the copy to it, or of the pattern match can only lose the hint line, never turn a failed publish into a passing one. A successful publish never prints the hint even when the output contains the matching text (tested).

Non-blocking notes: with the hint on, npm's error stream is merged into standard output for the log copy, which changes nothing in the Actions log; if the copy process died mid-run npm could see a closed pipe, which applies only while the variable is `true`; the match is anchored to npm's exact wording, so a wording change by npm silently drops the hint and nothing else; the branch that falls back when the temporary file cannot be created has no test. The decision record on this branch declares tier 1 against a suggested tier 2 and records that as below the floor with a passing verdict; I reviewed the change at the declared tier and leave the tier question to the merge-time decision-audit check.
