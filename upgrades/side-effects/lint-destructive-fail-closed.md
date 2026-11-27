# Side-Effects Review — destructive-operation lint scan completeness

**Version / slug:** `lint-destructive-fail-closed`  
**Date:** 2026-11-03  
**Author:** Echo desk, integrating Justin's 2.0 agent PR #2641  
**Second-pass reviewer:** independent reviewer subagent, 2026-11-03

## Summary of the change

`scripts/lint-no-direct-destructive.js` now records source paths it could not read, parse, or list, and returns exit 2 when inspection was incomplete and no definite violation was found. It retries transient read failures twice. Definite violations retain exit 1 and the incomplete paths are still reported. `tests/unit/lint-no-direct-destructive.test.ts` covers these boundaries. The release fragment and ELI16 overview explain the change. The decision point is whether a lint scan may certify a target set as clean; the existing policy still decides which destructive operations violate the rule.

## Decision-point inventory

- Lint scan completion and exit code — **modified**: an uninspected requested path makes a clean verdict unavailable.
- Destructive-operation detection — **passed through**: existing patterns and allow comments are unchanged.
- Release and pre-commit callers — **passed through**: they consume the command's result; this patch does not change those callers.

## 1. Over-block

A legitimate source tree can now fail lint when a file is temporarily unreadable or the parser throws. Two short retries cover transient read errors, but a longer file replacement may still require a rerun. A directory that exists but cannot be listed also fails, even if it ultimately contains no relevant source file, because the scanner cannot establish that fact. A missing optional directory remains acceptable. The cost is a failed development gate with a named path, which is repairable without changing product state.

## 2. Under-block

The scanner still only inspects paths selected by its existing traversal and file-extension rules. A destructive call outside those targets or hidden behind dynamic code can evade the preexisting detector. Explicit paths that do not exist, and staged paths whose files cannot be stat'ed, are filtered before the read loop; those remain a separate missing-target gap. A target file that is modified after it was read can change before a later build step. The normal `npm run lint` chain stops on exit 2, but `scripts/pre-push-gate.js` currently turns exit 2 into a warning. That caller can still let an incomplete pre-push scan through. This patch changes the scanner's verdict for selected paths; it does not make every caller reject that verdict or claim a transactionally frozen repository snapshot.

## 3. Level-of-abstraction fit

Scan completeness belongs inside the scanner, where read, parse, and directory-list errors are visible. The existing development and release gates consume its exit code; a separate downstream checker could not recover which path was skipped. This is a structural validator for an attempted inspection, while the existing destructive-operation detector retains its policy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] This is a hard-invariant validation: a scan cannot certify a selected path it did not inspect.
- [ ] This adds a semantic judgment based on a brittle signal.

The principle explicitly permits structural validation and safety guards for destructive actions. The rule here is enumerable: an attempted target path was inspected or it was not. Exit 2 says “could not inspect” and prints evidence; it does not claim a destructive operation was found or infer author intent. The existing gate owns whether to block the commit on that result. A failure may need a retry, but a clean verdict must not be fabricated.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The only new choice is whether every selected path was inspected. That is an invariant of the scan, not a ranking among liveness, urgency, ownership, or conversational signals.

## 5. Interactions

- **Shadowing:** The existing total-parser-failure branch still runs first; the new partial-hole branch follows it. A definite destructive violation still exits 1. The package-script JSON parser records malformed input rather than silently skipping it.
- **Double-fire:** A read failure records one path once; no separate worker is started. The diagnostic lists incomplete paths when a definite violation is present, avoiding a silent second failure.
- **Races:** A concurrent write may produce a transient read error. Two short retries precede exit 2; rerunning remains available. There is no shared mutable state across lint processes.
- **Feedback loops:** The lint is invoked by development gates and may stop a commit or push, but it does not mutate the source being inspected or schedule a new run.

## 6. External surfaces

Other contributors and agents see path-specific stderr and exit 2 for an incomplete scan that previously looked clean. Existing scripts that distinguish exit 1 from exit 2 retain that distinction, including the pre-push gate's warning behavior. No Telegram, GitHub API, database, or user message is emitted by the lint. No operator-facing action is added; resolving a named unreadable file remains a developer task. Runtime product behavior is unchanged until a developer invokes the lint gate.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard, approval, or grant form is changed.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** Each checkout's files, permissions, and parser installation are machine-specific facts; each machine runs its own lint against its own source tree. The result has no agent conversation, durable user state, notice, or URL to replicate. A PR merges only after its relevant gate evidence is evaluated for the code being shipped.

## 8. Rollback cost

Revert the source and test commit, then rerun lint. No state migration or user repair is needed. A revert restores the old incomplete-scan behavior, so it should be used only if the new diagnostic itself is faulty; the named path gives a narrower repair route.

## Conclusion and class closure

The change handles unreadable files, thrown parses, malformed package scripts, and unlistable existing directories with one incomplete-scan record path. A selected file that reaches the read loop is no longer silently skipped. Remaining limits include missing paths filtered before that loop, the pre-push caller's warning treatment of exit 2, and the existing pattern policy. The focused tests and exact-head local gate are the verification surfaces; the new commit needs its own exact-head gate before merge.

## Independent second pass

Confirmed the pre-push warning and pre-enumeration missing-path gaps are disclosed under Under-block; the selected-path scan-completeness change is reversible and consistent with the structural safety-guard exception in `docs/signal-vs-authority.md`. **Concur with the review.**
