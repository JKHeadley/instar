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

1. Medium, fixed. Adding `docs/DESIGN-STANDARD.md` and `docs/design/**` to `HARNESS_GLOBS` would have sent every ordinary rule change, and every prose edit to a design page, to `awaiting-independent-review`. The approved spec, section 1, lists only the gate's own files. The globs are now `src/designGate/**`, `src/commands/designPolicy.ts`, `docs/design/screens.json`, `docs/design/coverage.json` and `docs/design/rule-ids.lock.json`. A unit test asserts that the standard and other design pages are not harness-changing. This is a merge-routing change for exactly those files, and section 1 above should be read with that. It also resolves the harness-path review's note that `docs/design/opt-in-heartbeat.md` would ask for review.
2. Medium, fixed. Deleting a rule with no "Earned from" mark, or renaming its heading so it no longer parses, produced a clean `structurally-valid` report. The inspector now reports `rule-removed` for any base rule missing at the head, earned or not. Two unit tests cover deletion and a broken heading.
3. Low, recorded, not fixed here. Native Mac, iPhone, Android and Windows UI files are not detected as UI outside the registry. The spec puts native classification in each family's own copy, which is a later stage.
4. Low, recorded, not fixed here. Pointing `--repo` at a subdirectory reports `policy-missing` rather than "not the repository root". It fails safe; only the reason is unclear.

The reviewer also confirmed that nothing in Local Verify, monitoring or safe-merge calls the command, that the `SafeGitExecutor` change only admits `--no-lazy-fetch`, and the Git reading bounds. After the fixes: TypeScript type check exits 0, and the policy inspection, harness classifier and standard parser unit tests pass (70 tests).

## Class-Closure Declaration

- Defect class: `unbounded-self-action`.
- Closure: `n/a`.
- Reason: this command is one explicit manual invocation with a finite Git read budget. Capacity or timeout termination acts only on its exact owned Git child. No periodic trigger, retry, restart, notification or self-redrive controller is installed.

## Second-pass review of the harness path only (Chief of Staff helper, head 21c8cc467)

**Reviewer:** independent second-pass reviewer, Claude Fable 5.2 helper for the Echo Chief of Staff session, not the author

Concur for head `21c8cc467780469ac796610ca1efab43efa207c9`, limited to the path that flags this change as harness-changing: `src/localVerify/harnessClassifier.ts`. I read its diff, the rest of that file, where the list is consumed (`classifyHarness` and the verifier's policy hash), and the one-line edit to `tests/unit/localVerify/harnessClassifier.test.ts`. I also read the command wiring in `src/cli.ts`, `src/commands/designPolicy.ts` and the one flag added to the Git executor's allow-list. I did not review the design-gate modules or their tests in depth, and I did not rerun any tests.

- **It does what it says and nothing else.** The classifier change is four added entries in the harness path list: the design-gate source folder, its command file, the design policy folder under `docs/`, and the design standard document. No entry is removed or narrowed and no logic changes.
- **No check is weakened.** The list only ever adds a flag, so the change can make more pull requests need an independent review and can never make one need less. The existing table test gains the four new paths as cases; nothing is removed, skipped or loosened.
- **No newly silent failure.** A path matching a new entry is reported by name in the record's reasons, exactly like the existing entries.

Non-blocking notes: the `docs/design/**` entry also covers the unrelated note `docs/design/opt-in-heartbeat.md` already on main, so an edit to it will ask for a review (the safe direction); the harness list is an input to the verifier's policy hash, so once verifier machines run a build containing this change, recorded results made under the previous list stop counting and waiting pull requests are verified again, as with any change to this list; the list's doc comment still says a match "routes a PR to the operator", which predates the independent-review rule. This pull request was a draft when reviewed.

## Documentation-coverage correction (2026-11-27)

The Docs Coverage check failed with commands at 59 percent against a 60 percent floor. The check finds a command's documentation by its file name, and the file was `src/commands/designPolicy.ts` while the shipped command is `instar design:inspect`, so no documentation could ever match it. The file is renamed to `src/commands/designInspect.ts` with no change to its contents. The three places that named the old path follow it: the dynamic import in `src/cli.ts`, the harness path list in `src/localVerify/harnessClassifier.ts`, and the matching case in its unit test. The harness list keeps exactly the same set of files; only the one path's spelling changes, so it flags the same changes for independent review as before.

The command is now documented on the documentation site, in the CLI reference and on a new Design Policy Inspection feature page added to the Features sidebar. With both, the command total is 61 percent and the check exits 0 locally. No behavior changes. Earlier review notes that name `src/commands/designPolicy.ts` refer to this same file before the rename.

## Second-pass review of the rename

**Reviewer:** independent second-pass reviewer, a fresh Claude Opus 5.5 general-purpose helper started by Echo on the Mac Studio on 2026-11-27, not the author. It was given the staged change and the questions to check, not a conclusion.

Concur. The renamed file has the same content blob as the original (`66fb861e1a2acb9d565167ca91a9ef6117628a76`, a 100 percent rename). In `src/localVerify/harnessClassifier.ts` only the one path entry changes spelling. The matcher anchors each pattern at both ends and treats a pattern with no wildcards as an exact path, so the old entry matched only the old file and the new entry matches only the new file. No other entry covers either path, so the list flags the same set of files as before. A search of tracked files found no remaining import, build entry, configuration or test path that names `src/commands/designPolicy.ts`; the remaining mentions are earlier review notes in this artifact and audit records. The harness classifier unit test uses the new path and passed 44 of 44. The reviewer did not review the documentation-site pages.

## Screen registry catch-up after main (2026-11-27)

`tests/unit/design-screen-registry.test.ts` failed four tests on the previous head, and also on the head before the rename, because main had added screens the registry did not list. Data-only fix in `docs/design/screens.json`, no code change:

- New screen `console-capacity-repos` (the Repositories page, `#/capacity/repos`, rendered by `repos.js` from `repos-model.js`), with the same shared console files as its sibling Machine care page.
- `quota-forecast.js` and `quota-forecast-model.js` join the Accounts screen's sources, because `accounts.js` imports them.
- `needs-actions.js` and `repos-model.js` join the shared files of every screen that already shares the Needs You strip, because `needs-strip.js` and `needs-model.js` import them.
- Two public site pages are registered as screens instead of excepted, because a person sees them: `site-agent-link-fallback` (`/a`, the permanent agent link fallback) and `site-link-computer-fallback` (`/link/computer`).

Every new entry is `uncaptured` and tracked by the same commitment as the rest of the registry. On the M5, the registry validator returns no errors, every dashboard and pairing asset classifies as registered, and the only unregistered outside-root files are the nine with written exceptions.

## Pre-queue review (rule 7) and fixes, 2026-11-27

**Reviewer:** independent pre-queue reviewer, fresh Claude Opus 5.5 helper of the Design Standards session, not the author. Head 7810899156 against main d66e82bd5. Verdict: dissent on five items, all fixed in this change.

1. Fixed: the inspector read both sides of every changed script file under the 2 MiB policy cap, so any change touching `src/server/routes.ts` (2.9 MB) or `src/commands/server.ts` (2.5 MB) came back unavailable (9 of 26 recent main commits). It now reads source text only for the paths the classifier actually reads (`pathsNeedingSourceText` in `surfaceClassifier.ts`, sharing the classifier's own rules), with a separate 8 MiB per-side cap for those reads. The 16 MiB aggregate cap is unchanged.
2. Fixed: main added `dashboard/console/chat-outbox.js` and `dashboard/console/outbox-runner.js`, both imported by `console.js`. They join the shared files of every screen that includes `console.js`.
3. Fixed: main is merged. Main's release emptied `upgrades/next/`, and git guessed a rename for this change's upgrade note, so the note is kept under `upgrades/next/`.
4. Fixed: the machine-index row pattern in `standardParser.ts` was cubic on a long malformed row (2 s at 2,000 spaces, over 120 s at 10,000), and it runs synchronously, out of reach of the deadline. Rows are now matched once and trimmed afterwards. On the M5 the new parser gives byte-identical output to the old one on the standard at this head, on main and on PR 3956, plus an edge-case sample (one-sided ticks, tight cells, inner bars, no closing bar). A 20,000-space row parses in under a millisecond.
5. Fixed: the PR description is rewritten with a UX Impact section and the current state.

Also fixed from the non-blocking notes: `ls-tree` now runs with `--full-tree`, so running from a subdirectory no longer reports a false `policy-missing`.

New tests: an integration case where a registered file and a dashboard file over 3 MiB are changed and the result is still structurally valid; an integration case where an unregistered 3 MiB source is read and flagged while one over 8 MiB is unavailable; a unit case for `pathsNeedingSourceText` that checks the classifier finds nothing unreadable with only those texts; parser cases for linear time and for the old row shapes.

Still open, non-blocking, for later stages: tests for `read-deadline`, `MAX_DIFF`, the stderr cap, an invalid base registry and the CLI `invalid-policy` exit code; a `screen-deregistered` informational finding; coarse unavailable for a changed script symlink.

## Landing catch-up on the Mac Mini (2026-11-27)

Landed by Echo on the Mac Mini for the Design Standards session (the M5 could not run commit hooks). Three edits beyond the supplied patch, needed for the merged tree to pass:

- Main's merge added three rules to the standard: DS-LAYOUT-12, DS-LAYOUT-13 and DS-ACTION-8. They are issued in `docs/design/rule-ids.lock.json` (65 to 68 entries, nothing removed), and the parser test counts move to 68 rules and 28 machine-checkable (DS-LAYOUT-13 is the only new machine rule).
- The supplied patch put its two new parser tests and its new classifier test inside the body of the last existing top-level test, which vitest rejects. They are now separate top-level tests; the existing tests' assertions are unchanged.

**Reviewer:** independent reviewer, a fresh Claude Opus 5.5 general-purpose helper started by Echo on the Mac Mini on 2026-11-27, not the author. It was given the three edits and the claims to check, not a conclusion. Concur: the lock and the standard both hold the same 68 IDs with no duplicates; the standard has 28 machine-index rows and 28 rules marked machine; the nesting fix only adds closing lines after the existing tests. The three test files passed 41 of 41.
