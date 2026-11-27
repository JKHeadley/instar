# Side-Effects Review — executor review leaves out the publisher's own evidence files

**Version / slug:** `executor-review-omits-publisher-evidence`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (a revert undoes it). A follow-up to #3209. Since #3209 the trusted publisher adds a decision record (`.instar/instar-dev-decisions/<ts>-<branch-slug>.json`) and a release note (`upgrades/next/<branch-slug>.md`) to every executor PR. The independent review prompt's rule 2 calls anything under `.instar/` a finding, so both reviewers refused the first post-#3209 executor PR on that alone (PR 3235, 2026-11-16 11:18Z: codex-cli "Rule 2 — Tooling … `.instar/instar-dev-decisions/…json`", claude-code "Rule 2: edits under `.instar/`"). With no change, every executor PR would fail review.

Fix: before the prompt is built, `withoutPublisherEvidence` drops a file from the file list and its section from the diff only when three things hold. The path is this branch's record path (`.instar/instar-dev-decisions/<ISO-ts>Z-<slug>.json`) or note path (`upgrades/next/<slug>.md`). The section adds a new file. And the added bytes are exactly what the publisher writes, rebuilt from the PR's other paths and the attempt's ids, with the record's timestamp taken from its own file name. Anything else stays in view. The prompt names the omitted paths, in trusted text before the data line, and says they are not part of the change and not a rule 2 finding. The CODEOWNERS check still reads the full file list. Rule 2 itself is unchanged: any other `.instar/` path is still shown and is still a finding.

Effort: one build round, one commit attempt.

## Decision-point inventory

The independent review gate (an authority) gets a narrower input: the session's change without two publisher-written files. Its rules and its verdict logic are unchanged.

## 1. Over-block

None. This removes a false refusal.

## 2. Under-block

The confined session cannot write either path. `.instar/` is held by isToolingPath, and session-written `upgrades/next/` files are dropped before publication (#3209). A later push or a maintainer edit (gh leaves maintainer edits on) that changes either file changes its bytes, so it no longer matches the rebuilt content and is shown to the reviewers. A second or altered record, a modification, and a rename into an evidence path are all shown. Residual: the reviewers do not read the two files when they are byte-identical to trusted output. That content is fixed-shape and covered by tests that run the real decision-audit, release-fragment and upgrade-guide checkers.

## 3. Level-of-abstraction fit

Right layer. The diff is narrowed where the executor already assembles the reviewer input. Exempting `.instar/` in the rule text instead would loosen rule 2 for every path.

## 4. Signal vs authority compliance

No new authority, and the existing authority's rules are unchanged. The filter is an exact, pinned path match, not a heuristic.

## 4b. Judgment-point check

Not a competing-signals point.

## 5. Interactions

- CODEOWNERS check: unchanged, still sees all files.
- `isSpecReviewHead`: now given the filtered files and diff. Spec PRs carry no evidence files today (docs-only change sets need neither), so there is no change in behavior.
- `feedbackReviewLead`: given the filtered paths, so the lead is picked from the session's change.
- REVIEW_DIFF_MAX_BYTES: checked against the filtered diff (slightly smaller).

## 6. External surfaces

The reviewer prompt gains one trusted line when evidence was omitted.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the executor runs on the lease owner only.

## 8. Rollback cost

Revert. Executor PRs would then fail review on rule 2 again.

## Conclusion

Ship. Without this, #3209 cannot produce a mergeable executor PR.

## Second-pass review

Independent reviewer (subagent, given the code and the spec). **Concern raised (major):** the first version hid any file at the evidence paths. A later push or a maintainer edit that rewrote only the release note would produce the same filtered diff and pass re-review unseen, an injection channel into notes every agent reads, and the record pattern would also hide a second record. **Minor:** a rename into an evidence path left the file list and diff disagreeing. Otherwise concur: the untrusted session cannot reach either path, the diff splitting cannot hide a session file, regex escaping is correct, the prompt's named paths are fixed-pattern, and the CODEOWNERS, spec-head and lead checks behave.

**Resolution:** a file is now hidden only when its section is a new-file addition whose bytes equal the publisher's output, rebuilt for this attempt (`expectedPublisherEvidence`, `addedFileText`). New tests cover a rewritten note with injected text, a second and a forged record, a record whose scope doesn't match the PR, a modification, and a rename: all stay in view. A full publish-flow test hides the real pushed bytes and shows a tampered note. **Reviewer concurred after fixes: yes (the major concern is closed by the content check the reviewer proposed, rebuilt rather than stored, so no store migration is needed).**
