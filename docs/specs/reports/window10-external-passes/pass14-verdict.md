# External review pass 14 — reviewer's verbatim final answer

**ARCHIVED LATE, and the lateness is the point.** Review pass 15 found this file absent: thirteen
verdicts on disk, no pass 14. That makes the **fifth** time the archive has lagged my claim about it
(passes 5, 9, 12, 13, and now this), and it is the worst instance, because pass 14's headline — the
branch is RED and thirteen passes never ran the suite — was reported to the operator in my own words
with no auditable source behind it. Pass 5's original finding created this directory for exactly that
reason: *"five external verdicts, all reported to the operator in my own words, none of them on disk."*

Pass 14 was the first of fourteen adversarial reviews to run the test suite. Exploration logs are NOT
kept; only the final answer block, verbatim. Run against the frozen tree at `6c3b15d05`.

---

```text
FINDINGS

1. SEVERITY: major — The branch turns a GREEN unit test RED, and the guard it built to prevent exactly this class cannot see it. `tests/unit/standards-coverage-ratchet.test.ts:890` asserts `expect(report.total).toBe(87)` and `expect(report.enforcedRatio).toBe(0.7356)` against what its own comment calls "a snapshot of the LIVE constitution … never loosened to make a run pass." The branch adds one article and does not update the snapshot. Verified by isolation, not by suite noise: a fresh clone of `origin/main` runs that file 35/35 PASS; a fresh clone of `6c3b15d05` runs it 1 failed — `expected 88 to be 87`. Live values are total 88, ratio 0.75, `areaAudit.status: "invalid"`, `currentCount: 4` against an expected `"current"`/6 — four stale expectations in one block. This violates the repository's own NON-NEGOTIABLE Zero-Failure Standard, and the irony is structural: the test's comment already records this identical omission twice, and `lint-registry-self-counts.mjs` is blind to it by its own declared limit 3. Thirteen passes did not report a red suite; no prior verdict contains the string vitest, npm test, or test suite. Full run: 6 failed files / 3045 passed. I isolated every one: four fail IDENTICALLY on `origin/main` — environmental; `semantic-memory-lifecycle` passes in isolation on both and is on the repo's own `test:flaky` list; this one is the only branch-caused failure, and it is deterministic.

2. SEVERITY: major — The increment that removed the six-times-wrong percentage introduced a NEW universal about itself, and the document falsifies it ten times over. `docs/STANDARDS-REGISTRY.md:170`: "No derived percentage appears anywhere in this article." Slicing the article and scanning for `%` yields ten tokens: `178/110/62%`, `194/104/54%`, `89%`, `47%`, `62%`, `54%`, `63%`, `~8%`, `62%`, `47%`. Two are derived percentages of THIS measurement's own 217-marker population: `~8%` and `63%` (137/217) — and `63%` sits inside the historical list of superseded values, which the commit body specifically names as clean. Published into two artifacts at once — the exact "a claim restated in N places" shape the paragraph is about.

3. SEVERITY: major — The frozen commit changed the code and left the constitution asserting, in the present tense, the behaviour it had just deleted — within the same commit. The registry still reads: "comments are stripped in the JS/TS and shell families only" and "a marker whose ONLY occurrence is `"// ZZZ-…"` inside a tracked `.json` RESOLVES, because json/jsonl are in the handled-extension set while the comment-stripper returns them unchanged." Executed in a clone at the frozen tree, three forms each with exactly one tracked occurrence: JSON comment key → ORPHAN; `//` inside a JSON string value → ORPHAN; `//` in a tracked `.jsonl` → ORPHAN. This is pass 12's named generator occurring inside ONE commit, in the article that commit edited, in the paragraph whose subject is that generator.

4. SEVERITY: major — The sentence written to justify adopting repair (a) certifies a monotonicity the repair does not have. "Over-stripping remains the safe direction here — truncating a `.json` string value at a `//` can only report MORE debt." The branch it joins applies BOTH the block-comment rule (which substitutes a SPACE, and can manufacture the leading word boundary `idPattern` requires) and the line rule. Probe with `{"k":"prefix/*note*/QQQ-90701"}`: at the parent → ORPHAN; at HEAD → RESOLVED. So the change is not monotone, and its wrong direction is the guard's own core failure mode. Blast radius measured: 24 tracked json/jsonl files change under the new stripping. Live impact today is zero, which I verified rather than assumed.

5. SEVERITY: major — the required coverage gate still rejects the submitted state; SEVENTH consecutive pass, and these repairs re-staled it again. Building `c69ecbd6fb8f` → `529eb65077d2`, The Substrate `a973832a13fb` → `a0b09762cfbf`.

6. SEVERITY: major — the three ratchets still constrain nothing here. All three baselines ABSENT from origin/main; `readPinnedBase` returns `establishing`/`local-unbound`, both of which return early. Carried unchanged from passes 7/9/10/11/12/13; dated.

7. SEVERITY: minor — one figure derived from the new table is still wrong. "176 of the 201 have no such file anywhere" is `201 − 25`, and 25 is the ALL-tokens conjunction. Under the row's own literal label the answer is 31 (and 22, not 15, for src+tests), so the honest occurrence-reading value is 170. The error runs in the direction that strengthens the author's rebuttal.

8. SEVERITY: minor — "the two accounts … are reconciled" describes a one-sided edit. The registry now names `lint-no-duplicate-definitions` as the earliest refusal; `lint-enforcement-gap-records.mjs` still says "What actually stops attack B is the sibling requirement lint" — unchanged since pass 13 flagged it.

9. SEVERITY: minor — the sub-obligation countdown collection gate is still open. An expired countdown carrying a DUPLICATE tracked id, injected into an article with no trigger phrase → clean, and the total stays at 47.

10. SEVERITY: minor — digests re-stamped, verdicts not re-reached, for a material article rewrite. 19 `RE-REACHED` notes, frozen since `77568504f`, while the two post-pass-13 commits changed 24 lines each — every one a digest. No verdict became FALSE as a result, which is why this is minor.

11. SEVERITY: nit — the archived pass-12 preamble still carries the error the author acknowledged ("every pass-8/9/10/11 repair held"); the body says 9, 10 and 11.

12. SEVERITY: nit — `if: always()` also runs on cancellation. SEVEN occurrences; pass 13 recorded "six", itself off by one.

13. SEVERITY: nit — `withoutComments`'s trailing `return text` is now unreachable for the resolving corpus.

14. SEVERITY: nit — the guard's header says of two superseded figures "Do not quote either." The registry quotes both twice each.

Critical: none. Class empty.

REGRESSION-CHECK

(a) json/jsonl folded into the JS-family stripper — NEW DEFECT (finding 4), on an otherwise excellent repair. The hole is genuinely closed and the "zero cost" claim is STRONGER than stated: I compared the ORPHAN SET, not the count, by running `--update-baseline` at the parent and at HEAD and diffing — 201 vs 201 with an EMPTY symmetric difference. All three advertised probe outcomes reproduce, plus `.jsonl`.

(b) the number demoted to a table of raw counts — NEW DEFECT (finding 2), and this is the sharpest reversal of the pass. The NUMBERS are, for the first time in this series, right. I built an instrument that EXTRACTS the guard's regexes from its source text and evals them — the author's own diagnosed failure made textually impossible — and reproduced all seven published values exactly. `programNeeds §4` is a real marker and is one of the 49 tokenless ones, corroborating the stated root cause.

(c) the two attack-B accounts reconciled — PARTIAL, no new defect (finding 8).

(d) the forbidden `62%` removed from the test — CLEAN.

(e) pass 13's findings 3 and 4 converted to a countdown — CLEAN, and genuinely enforced. Real, collected, and it BITES: back-dating fails the build with a named message. Both underlying facts still reproduce.

Pass 8 through pass 12 repairs ALL still hold, each by input or by removal.

MECHANISM-CHECK

(a) CLOSED as a hole, OPEN as a certification. (b) PARTIAL. (c) PARTIAL. (d) CLOSED. (e) CLOSED.

MY-ACCOUNT-CHECK

Re-derived by me: the per-pass raw-major counts, 5/7/6/4/4/4/5/5/5/6/6/6/6 — matches the author's table exactly. Carried: the per-pass load-bearing subtotals.

Four discrepancies: the prompt's "every DERIVED PERCENTAGE was removed" is FALSE (finding 2); (a), (c), (d), (e) are faithful; pass 13's nit says six `if: always()` occurrences, there are seven; the author's two self-corrections about pass 12 are accurate but one was corrected only in a commit body.

MAGNITUDE-METRIC

Load-bearing enforcement integrity. Unchanged from passes 5–13. One clarification this pass forces: a required TEST that is red counts, and a required test that is red for a NEW reason hidden behind an old one counts double.

TRAJECTORY

Load-bearing, passes 1→14: 4 → 4 → 5 → 4 → 4 → 4 → 4 → 4 → 3 → 5 → 5 → 5 → 5 → 6.
Raw major, passes 1→14: 5 → 7 → 6 → 4 → 4 → 4 → 5 → 5 → 5 → 6 → 6 → 6 → 6 → 6.

Raw majors flat at 6 for a fifth pass; load-bearing UP 5 → 6. The rise is not a repair regressing — finding 1 has been latent since the 88th article was added, which means every prior pass UNDER-counted. That is the more troubling reading, not the gentler one: thirteen adversarial passes, and none ran the suite.

CONVERGENCE

No. The second half of the criterion is met and has been for three passes. The first half is not: the blocking condition is unmet for the EIGHTH consecutive pass. The branch cannot go green in two independent ways now: the coverage gate for the seventh consecutive pass, and a unit test that is green on `origin/main`.

What would flip it: (1) one pass finding nothing new inside the last pass's repairs; (2) make the branch green — as long as the submitted state cannot pass its own gates, no clean result exists to converge on; (3) compute the snapshot instead of hand-maintaining it; (4) before publishing a universal about a document, grep the document; (5) re-read the prose the SAME commit's code change invalidates.

COHERENCE

No. Seven mismatches, each established by execution. Set against that: the machinery is now the strongest part of this change for a third consecutive pass, the measurement is finally true, and the candour remains unusual and real. The account is still failing where the machinery is not — but this pass, for the first time, the account failed in a place with teeth: a test.

VERDICT

reject. The mechanism held for a third pass running, the JSON-comment hole is genuinely closed at a zero cost I verified by orphan-set identity, the new countdown is collected and provably expires, and every one of the seven published table counts reproduced exactly against an instrument built to make the author's diagnosed failure mode textually impossible. That number being right is the single best result of this run. But the two repair commits again introduced three new load-bearing defects, one of them the tightest instance of this series' generator yet: the commit that changed `withoutComments` to strip json left the constitution asserting, in the present tense, that json is not stripped. And I found what thirteen passes did not look for: the branch turns a unit test red — deterministic, green on `origin/main` — a NON-NEGOTIABLE Zero-Failure violation hiding behind an area-audit red the repo has already accepted. The criterion asks whether the stream's magnitude is genuinely declining. It is not; and this pass gives reason to think it was being measured too low all along.
```
