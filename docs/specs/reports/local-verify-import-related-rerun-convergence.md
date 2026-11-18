# Convergence Report — Local Verify: a second try for a failed test that only imports changed code

## Cross-model review: codex-cli:gpt-6-astra

A real outside (GPT-tier) review ran through the agent's codex CLI in rounds 2, 4, 5 and 6. Rounds 1 and 3 degraded (round 1: the installed reviewer script asked for a retired model; round 3: timeout on the longer text). A second, clean-door Claude review (claude-opus-5-5) ran in rounds 4, 5 and 6; it is not a cross-family opinion and says so itself.

## ELI10 Overview

When a change is tested on our two test machines and one test fails, the line normally runs that one test again by itself. If it passes alone, the failure is treated as bad luck and the change is not blamed. There is one exception: if the failed test uses any code the change touched, it gets no second try. That sounds careful, but for a change that edits a central file, almost every test uses that file, so such a change gets no second tries at all. On 18 November a privacy fix was failed three times this way, by three different unreliable tests, and needed four runs.

This spec adds a narrow second chance. A failed test that merely uses changed code may be tried again only when that very same test has already been seen failing and then passing on the main branch itself within the last seven days. A change that has not merged cannot produce that evidence, so it cannot talk its own failures away. The test must then pass three times in a row alone, and each time the exact test that failed must be reported as passed by name.

The rule ships switched off. It is tried first on a throwaway test agent, then on our own development machines, and reviewed after seven days with written rules for switching it off or keeping it. The honest cost of being this strict: on the first day it saves nothing, because the evidence has to be collected first; after a week it would have saved about two of the three wrong failures of 18 November.

## Original vs Converged

The first version was simple and too trusting: any failed test that only uses changed code would get three solo tries. Reviewers showed why that is weak. A change that introduces a timing fault usually fails when the machine is busy and passes when the test runs alone, so three solo passes prove little by themselves.

The second version asked for evidence from other changes ("this test also failed and passed under two other changes"). Reviewers showed an author could manufacture that with decoy changes, and that a "one clearance per change" memory lived on one machine and was lost when the coordinating machine changed.

The third version took evidence only from the main branch, per test file. The outside reviewers pointed out that the evidence was about a file while the clearance was about a test: a different, newly broken test in the same file would ride along.

The fourth version matched by test name but kept fallbacks (old log lines, title-only matches, file-level matches) that reviewers found to be loose ends: four design findings in one round.

The converged version is a cut. Evidence is the named test, seen failing in a lane and passing alone by name on a main-branch verify, within seven days. There is no seeding from old logs, no title matching and no file-level fallback. A helper machine applies the rule only when the coordinator's request enables it and its own switch is on, and the coordinator refuses a helper's result that clears a test it did not offer. Losing any stored state can only make the rule stricter. The first-days gap and the two-of-three figure are stated plainly in the spec.

## Iteration Summary

| Iteration | Spec version (body hash) | Reviewers who flagged design | Design findings | Left behind | Spec changes |
|---|---|---|---|---|---|
| 1 | v1 (f4a8660…/f4633e05) | security, adversarial, integration, decision-completeness, lessons-aware | 10 | 14 | Evidence requirement added; peer needs its own switch; import-side check; cross-PR signal dropped; scan blind spots stated; carriers named |
| 2 | v2.1 (a545d866) | security, adversarial, scalability, integration, decision-completeness; codex | 7 internal + 2 codex | 10 | Evidence from main only; one-clear rule dropped; detail-only passes never recorded; review computed from the audit log |
| 3 | v3.1 (a1d15a47) | none internal (codex timeout, clean door error) | 0 | 9 | Pass by test name replaces skip counts; precision edits |
| 4 | v3.2 (908faeba) | codex (2), clean-door Opus (1) | 3 | 6 | Per-test evidence; review identity |
| 5 | v4 (00928f35) | decision-completeness (1), codex (4) | 5 | 10 | Cut: named evidence only, no seed, no titles, no fallback; validation split |
| 6 (cap) | v5 (2214a03b) | decision-completeness (1), codex (2), clean-door Opus (2) | 5 | 8 | Cheap fixes in a last edit; the rest recorded under Left behind |

Standards-Conformance Gate: ran before round 1 (4 flags), round 2 (6 flags), round 3 (4 flags), round 5 (6 flags), round 6 (5 flags); round 4 reviewed precision-only edits of round 3's text and used round 3's run. Every flag was handed to the reviewers; by round 6 all remaining flags were fixed limits, each given a verdict by the decision-completeness reviewer (accepted: inherited or tighten-only, reviewable at day 7).

## Proportion

Tier 2 (changes a merge gate: about 8 source files in `src/localVerify/` plus the self-action registry; spec about 8,300 words). 6 rounds used of a cap of 6. ⚠ The effort is high for the size of the change: the design was rewritten three times and ended at the cap. The rewrites were substantive (each removed a way to manufacture evidence or lose state), but the build should be kept small.

## Experience fit

Source: the operator's words in topic 130715, #142464 (lean on intelligent assessment rather than fixed limits; tell hung from slow) and the 18 November run of PR 3430. Contrasting cases weighed: a core change hit by a test that is known to flake on main (should not be failed for it) against a change that introduces a timing fault in a test that only fails under load (must not be cleared). Evidence limits: the two-of-three figure rests on the Studio's audit log; the third failure's shape on main is unconfirmed. Disposition from the lessons-aware reviewer, final round: still worth building, modestly; it is a strict, auditable rule and not an intelligent assessment, and the spec says so. The number that decides whether it matters: import-related clears divided by clears plus all import-related refusals over the first seven days; under one in four means too strict, and the owner then brings a file-level variant through review as a separate change. No operator step in the ordinary path and no new notices.

## Left behind

Design findings accepted at the round cap (none is a security or data-loss finding):
- No automatic trip after the day-7 review (clean-door Opus, round 6): a test that a merged change made flakier renews its own main evidence. Accepted for the two dark rungs; a recurring check is a named condition for any fleet rung. Queue: the throughput session's follow-ups.
- Solo re-runs do not test the in-load condition (clean-door Opus, round 6): wording corrected to say solo was chosen for cost and because it is the existing mechanism's shape. An in-load retry is the named alternative, to be specified only if the review shows clears followed by main failures of the same test.
- Rate denominator must count only verifies that ran the file; the wire bound must be in bytes (codex, round 6); the refusal counts need a carrier the review script reads (decision-completeness, round 6): all three fixed in the last edit and not re-reviewed. The build's second-pass reviewer is asked to check each.

Precision items not iterated on:
- Confirm `fullName` and the meaning of `pending` on the pinned vitest at build.
- Fixed limits flagged by the standards gate every round (three passes; 3 files per verify; 7-day, 20, 40 and 500 store bounds; 200 and 300 request bounds; 20-test ceiling): inherited or tighten-only, basis stated in the spec's Limits section.
- Stale evidence lasts up to seven days after a flake is fixed on main.
- The two-step path (an author's earlier merged change makes a test flaky on main, a later change then benefits) is on the review's hand-read list.
- The history file's worst-case size is stated, not capped further; the review reads its real size.
- Import-scan blind spots of the existing rule: filed as feedback fb-9b2be76e-79d, outside this spec.
- The spec is long; a later edit could shorten it without changing the build.

## Full Findings Catalog

Round 1 (v1).
- Security, DESIGN: a peer-run request could switch the looser rule on while the peer's own switch is off. Resolved: peer applies it only with both; coordinator refuses unoffered clears.
- Security, DESIGN: "unreadable is treated as possibly related" is untrue of the real import scan, which swallows errors. Resolved: claim withdrawn, limit stated, feedback filed.
- Adversarial, DESIGN: three solo passes do not test an in-lane race. Resolved over rounds 2 to 5 by requiring independent evidence.
- Adversarial, DESIGN: the proposed signal excluded same-PR repeats. Resolved: signal dropped; repeats visible in the audit log.
- Integration, DESIGN: Frontloaded Decision 4 described a fallback path that does not exist. Resolved: replaced with the verified fact (a restarted peer abandons the attempt).
- Integration, DESIGN: the signal's counter was machine-local with no justification. Resolved by removal.
- Decision-completeness, DESIGN x3: the measure could not confirm the number; recording had no carriers; rung 1 needed a scan that cannot throw. Resolved: review rule rewritten, fields named, case removed.
- Lessons-aware, DESIGN: foundation claim without a carrier (same scan issue). Resolved as above.
- Precision (14): lane keeps re-running after a final failure; unbounded list; registry row; third noteFlaky site; type and validation details; rollback wording; skip criterion; others. Folded in.

Round 2 (v2.1).
- Security, DESIGN: one author can manufacture both "independent" sources with decoy PRs. Resolved: main-only evidence.
- Adversarial, DESIGN: a detail-only solo pass could feed the evidence list. Resolved: never recorded.
- Scalability, DESIGN: the day-7 review cannot be computed from the capped history. Resolved: audit log is the carrier. (Also raised by codex.)
- Integration, DESIGN: "stricter, never looser" is false for the one-clear rule when the coordinator moves. Resolved: rule and memory removed. (Also raised by codex.)
- Decision-completeness, DESIGN x3: switch-off rule fires on noise; detail-only recording gap; one-clear rule rejects a legitimate case. Resolved as above.
- Precision (10): folded in.

Round 3 (v3.1). All three internal reviewer pairs: zero design findings. Precision (9) folded in: stale evidence, per-file versus per-test noted, parser cost, double counting in the review, names stay in the child, review script named, optional seed. Standards gate: skip counts are a symbol; resolved by pass-by-name.

Round 4 (v3.2).
- Codex, DESIGN: review de-duplication by head collapses separate observations. Resolved: identity by finish time.
- Codex, DESIGN: no baseline of test names for the by-hand comparison. Resolved: names recorded with main evidence.
- Clean-door Opus, DESIGN: evidence is per file, the clear is per test. Resolved: per-test evidence.
- Precision (6): determinism claim qualified; seed condition; framing against a hand-kept quarantine list; detail-only budget; consistency check wording; glossary.

Round 5 (v4).
- Decision-completeness, DESIGN: title-only matching under-specified. Resolved by removal.
- Codex, DESIGN x4: main evidence must be checked by name; one flag cannot describe mixed title and full-name lists; validation conflict between shared and clearance fields; fallback makes state loss loosen the rule. Resolved: by-name collection, titles and fallbacks removed, validation split.
- Precision (10): folded in or listed above.

Round 6 (v5, cap).
- Security and adversarial: converged; state loss only tightens, confirmed path by path; dropping the skip count loses nothing. One precision (PR-authored text is data): folded in.
- Scalability and integration: converged; worst-case history read acceptable as stated. Two precisions: folded in.
- Decision-completeness, DESIGN: the "too strict" counts had no carrier the review script reads. Fixed in the last edit; listed under Left behind.
- Codex, DESIGN x2: rate denominator; byte bound. Fixed in the last edit; listed under Left behind.
- Clean-door Opus, DESIGN x2: solo rationale; no check after day 7. First fixed in wording, second accepted with a condition; both under Left behind.

## Convergence verdict

Converged at the round cap (round 6 of 6) with five design findings recorded under Left behind as the process requires: three fixed in the final edit without a further review round, one corrected in wording, and one accepted with a condition on any wider rollout. None concerns security or data loss. Open questions: none. The spec is ready for review and approval by the Chief of Staff; nothing is built before that approval.
