# Manual Design Policy Inspection: Side Effects

## Summary

Tier 2 implementation of the approved design-standard-enforcement foundation. Adds a manual, read-only command; the remaining gate stages stay on the approved project's carrier. No automatic merge decision, daemon or external send is added. Git reads use the existing SafeGitExecutor audit and environment-scrubbing path; its ordinary audit records remain an expected local side effect.

## 1. Over-block

No application block/allow surface. A manual invocation can report unavailable for a large diff, large blob, timeout, symlink, missing baseline or malformed JSON. The limits are explicit operational bounds, and the report has no merge authority. Shared route files produce deliberately wider affected-screen signals.

## 2. Under-block

No merge authority is installed. The result explicitly excludes rendering, accessibility, coverage/modes, feedback-entry lint, semantic wording review and owner waivers. This complete manual inspection must never be substituted for those approved project stages. Embedded-HTML recognition remains a source detector, not a general proof that every possible dynamic UI was found.

## 3. Level-of-abstraction fit

Pure existing structural validators feed one manual report. The Git reader supplies pinned immutable tree inputs and refuses unreadable data. No second merge gate, reviewer or waiver authority is created.

## 4. Signal vs authority compliance

Complies with docs/signal-vs-authority.md. Classification and earned wording differences are observations. The report says mergeAuthority:false and names the checks it did not perform. No language matcher decides whether an earned rule was loosened.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Exact rule-ID history and document structure are enumerable invariants. Semantic wording review remains independent and unperformed.

## 5. Interactions

This command runs only when invoked and reads no mutable working files. It does not spawn a browser or call Local Verify. New design policy paths join the existing harness classifier so the checker cannot silently exempt edits to itself from independent harness review.

## 6. External surfaces

New CLI JSON and exit codes, documentation, and one awareness entry. No network, Telegram, native application, enrollment, signing or release side effect. Git errors are reported as bounded named unavailable reasons without raw stderr or host paths.

## 7. Multi-machine posture

Machine-local read by design over the repository the caller selects. Immutable commit identities make the compared inputs explicit on every machine. No replicated state or user-facing background notice exists. The awareness registry reaches new and existing agents through its existing update path.

## 8. Rollback cost

Revert the command, pure modules, registry and awareness entry. No database, daemon configuration, owner authority or generated state needs repair.

## Verification

Focused tests cover unchanged structure, lost history, lost provenance, tolerance changes, erased registration, unregistered UI, immutable reads, removed HTML, literal filenames, malformed JSON, symlinks and absent bootstrap policy. The real packaged CLI lifecycle has four passing cases, with no silent skip when dist is absent. Independent correctness and boundary reviewers concur after the bounded corrections below. Normal complete verification remains required before merge.

Git reads disable replacement objects and lazy fetching, use the existing Git executor to scrub repository/config environment redirection, and strictly decode UTF-8. Noncanonical backslash paths are unavailable instead of being rewritten into another file. Total Git output is capped at 16 MiB, including source blobs; aggregate bounds apply before retention. Older Git versions that cannot disable lazy fetch report unavailable. The deadline is checked again after synchronous inspection before returning a successful report.

## Independent correction review

Correctness and safety reviewers found replacement-object substitution, lossy UTF8/backslash path aliases and default BOM stripping. Real Git regressions failed before the corrections and passed afterwards. The source now preserves exact path identity or reports unavailable, disables lazy fetch/replacements and uses the executor’s existing repository/config redirection denylist, and enforces aggregate byte/deadline bounds. Both reviewers returned qualified concurrence with zero remaining material finding in that correction scope. This is source-review concurrence, not independently replayed complete verification. A third reviewer independently replayed all four actual CLI lifecycle cases; final compiled-candidate readback independently passed all four lifecycle cases and the actual FEFF Git regression, with qualified concurrence.

## Commit-hook integration correction

The first normal commit attempt was refused by lint-no-direct-destructive because new production and test Git calls did not use SafeGitExecutor. No hook was bypassed. The production reader now consumes SafeGitExecutor.readStream with bounded stdout and stderr, checks actual close status, and preserves strict UTF8 and deadlines. The executor admits only the known --no-lazy-fetch global flag, which disables implicit promisor fetching; no new Git verb or mutation authority is introduced. Synthetic tests use existing SafeGit verbs, constructing raw tree blobs through hash-object/commit-tree to preserve invalid filename bytes without a new update-index grant. The older extracted screen-inventory test also uses the audited read executor. These exact changes received a bounded second review before retrying commit.

Final rerouting readback: safety reviewer concurred on bounded streams and existing audit/environment policy. Test reviewer independently confirmed emitted SafeGit import and replayed all four CLI cases successfully. Focused168 tests including32 SafeGit tests pass; TypeScript emit exits0. No full-suite result is claimed.

## Second-pass review

**Reviewer:** an independent Claude Opus 5.5 second-pass reviewer, started fresh by the Design Standards session on 2026-11-26. It was given the code and the claims to check, not a conclusion.

Verdict: concur with findings. Each finding and its disposition:

1. Medium, fixed. Adding `docs/DESIGN-STANDARD.md` and `docs/design/**` to `HARNESS_GLOBS` would have sent every ordinary rule change, and every prose edit to a design page, to `awaiting-independent-review`. The approved spec, section 1, lists only the gate's own files. The globs are now `src/designGate/**`, `src/commands/designPolicy.ts`, `docs/design/screens.json`, `docs/design/coverage.json` and `docs/design/rule-ids.lock.json`. A unit test asserts that the standard and other design pages are not harness-changing. This is a merge-routing change for exactly those files, and section 1 above should be read with that.
2. Medium, fixed. Deleting a rule with no "Earned from" mark, or renaming its heading so it no longer parses, produced a clean `structurally-valid` report. The inspector now reports `rule-removed` for any base rule missing at the head, earned or not. Two unit tests cover deletion and a broken heading.
3. Low, recorded, not fixed here. Native Mac, iPhone, Android and Windows UI files are not detected as UI outside the registry. The spec puts native classification in each family's own copy, which is a later stage.
4. Low, recorded, not fixed here. Pointing `--repo` at a subdirectory reports `policy-missing` rather than "not the repository root". It fails safe; only the reason is unclear.

The reviewer also confirmed that nothing in Local Verify, monitoring or safe-merge calls the command, that the `SafeGitExecutor` change only admits `--no-lazy-fetch`, and the Git reading bounds. After the fixes: TypeScript type check exits 0, and the policy inspection, harness classifier and standard parser unit tests pass (70 tests).

## Class-Closure Declaration

- Defect class: `unbounded-self-action`.
- Closure: `n/a`.
- Reason: this command is one explicit manual invocation with a finite Git read budget. Capacity or timeout termination acts only on its exact owned Git child. No periodic trigger, retry, restart, notification or self-redrive controller is installed.

## Second-pass review

**Reviewer:** independent second-pass reviewer, Claude Fable 5.2 helper for the Echo Chief of Staff session, not the author

Concur for head `21c8cc467780469ac796610ca1efab43efa207c9`, limited to the path that flags this change as harness-changing: `src/localVerify/harnessClassifier.ts`. I read its diff, the rest of that file, where the list is consumed (`classifyHarness` and the verifier's policy hash), and the one-line edit to `tests/unit/localVerify/harnessClassifier.test.ts`. I also read the command wiring in `src/cli.ts`, `src/commands/designPolicy.ts` and the one flag added to the Git executor's allow-list. I did not review the design-gate modules or their tests in depth, and I did not rerun any tests.

- **It does what it says and nothing else.** The classifier change is four added entries in the harness path list: the design-gate source folder, its command file, the design policy folder under `docs/`, and the design standard document. No entry is removed or narrowed and no logic changes.
- **No check is weakened.** The list only ever adds a flag, so the change can make more pull requests need an independent review and can never make one need less. The existing table test gains the four new paths as cases; nothing is removed, skipped or loosened.
- **No newly silent failure.** A path matching a new entry is reported by name in the record's reasons, exactly like the existing entries.

Non-blocking notes: the `docs/design/**` entry also covers the unrelated note `docs/design/opt-in-heartbeat.md` already on main, so an edit to it will ask for a review (the safe direction); the harness list is an input to the verifier's policy hash, so once verifier machines run a build containing this change, recorded results made under the previous list stop counting and waiting pull requests are verified again, as with any change to this list; the list's doc comment still says a match "routes a PR to the operator", which predates the independent-review rule. This pull request was a draft when reviewed.
