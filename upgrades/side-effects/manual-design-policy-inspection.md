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

## Class-Closure Declaration

- Defect class: `unbounded-self-action`.
- Closure: `n/a`.
- Reason: this command is one explicit manual invocation with a finite Git read budget. Capacity or timeout termination acts only on its exact owned Git child. No periodic trigger, retry, restart, notification or self-redrive controller is installed.
