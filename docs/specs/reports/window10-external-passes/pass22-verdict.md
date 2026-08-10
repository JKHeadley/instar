# External review pass 22 — reviewer's verbatim final answer

**Filed ALONE and BEFORE the repairs, and required by the machinery.** Pass 22 verified ARM 3 as
enforcement rather than resolution — its words: *"I removed the verdict and watched the build refuse rather
than reading that it would."*

Pass 22 recorded load-bearing **3** (two new, one carried-with-a-new-element), credited the magnitude clause
as SATISFIED for the **fourth consecutive pass**, and found no defect in the four registry guards for the
**third consecutive pass** — this time under probe shapes nobody had tried (closed-ATX duplicate headings,
tab indentation).

It also **corrected pass 21's correction of pass 20**: the "fourteen" figure is population-dependent —
11 under the four-figure hand list actually configured, exactly **14** under the six-figure population the
authority declares — so pass 20's "unverifiable rather than false" hedge was closer to the truth than pass
21 allowed, and this repository propagated pass 21's flat version into three places. Run against
`db4a3f4c5`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 22 — `echo/window10-deep-property-guards` @ `db4a3f4c5`

**Grading rule declared up front, for comparability.** I keep the definition passes 17–21 used: *a finding is load-bearing if it either leaves a guard unable to refuse an input it claims to refuse, or leaves a committed artifact asserting something false about the machinery.* Where the prompt's broader wording ("a guard whose verdict is unsound", "a claim the machinery falsifies") would change the count, I say so explicitly rather than switching metrics silently. Every finding below was reached by execution — sabotage against a `git archive` clone, or input-feeding against a file-faithful sandbox — never by editing a guard to make it fail.

## FINDINGS

**1. SEVERITY: major (load-bearing; CARRIED artifact half of pass 21 finding 1, plus a NEW element) — the scan still cannot see a claim wrapped across a comment-prefixed or blockquote continuation; the repair ADDED, as a watched surface, the one file whose dominant wrap shape is exactly that; and the repair's own justifying comment is false about the lines it is written on.**

`.trim()` closes the *plain-indent* wrap. It does not close a continuation whose line begins with a prefix character. Verified by input against the real tree (control = identical claim on one line):

| wrap shape | surface | result |
|---|---|---|
| plain indent | eli16.md | **refused** at :1404 |
| markdown list indent | eli16.md | **refused** |
| JSDoc ` * ` continuation | lint-account-matches-tree.mjs | **clean, exit 0** |
| `// ` continuation | window10-guards-behaviour.test.ts | **clean, exit 0** |
| blockquote continuation | eli16.md | **clean, exit 0** |
| one-line controls, all three | — | refused |

The new element: `scripts/lint-account-matches-tree.mjs` was added to `CLAIM_SURFACES` in this commit (finding 11's repair). Its prose is a block header plus line comments — i.e. every wrapped sentence on the newly-watched surface is in the shape the arm cannot see. Its coverage of that surface is real only for claims that never wrap.

Sharpest instance, proven by feeding the guard rather than editing it. The repair comment at `:241-244` reads *"an indented continuation — the dominant wrap shape in these documents, **and in this very comment** — is invisible."* I retired the wording `the join between a line and its continuation`, which spans that comment's own line break: **0 hits**. I then retired `leading indentation must NOT survive`, wholly inside one line of the same comment: **refused at `:240`**. The comment claims the fix reaches its own shape; it does not.

Both artifacts pass 21 named as false are **unchanged at HEAD** — `lint-account-matches-tree.mjs:37-38` and `upgrades/side-effects/…md:2180-2181`, both still *"a claim wrapped across any number of lines is found exactly once."* The increment record quotes them as having "said the opposite" and corrects neither.

(Not a regression from the deleted window: I extracted `834ecb0b2`'s two-line join and it cannot cross a comment marker either. The code hole is old; what is new is the surface added on top of it and the comment asserting otherwise.)

**2. SEVERITY: major (load-bearing) — the ordinal decoder cannot resolve any round-tens ordinal, while the commit message and the engineering log justify the tens table precisely by saying it does.**

The record, in two committed artifacts: *"a tens table that goes past thirty-nine, **since a decoder that stops at a round number is the same narrow-population defect one order up**."* Enumerated over 1–100, the numbers the arm cannot resolve are exactly the round numbers: 30, 40, 50, 60, 70, 80, 90, 100.

Verified by input on the real tree: `The thirty-first reading…` enrols 31, `The forty-ninth reading…` enrols 49, `The thirtieth reading…` / `The fortieth reading…` / `The hundredth reading…` enrol **nothing**. The cause is structural: `ORDINAL_WORDS` ends at `twentieth` and `ORDINAL_TENS` supplies only the tens *prefix*, so `thirtieth` matches neither.

This is the recurrence of pass 21 finding 2 one decade later. `eli16.md` titles every section *"## Nth reading"*; the natural heading for the thirtieth reading will arm nothing. The sentence stating the property is false about the code sitting fourteen lines below it.

**3. SEVERITY: major (load-bearing under the stated rule; boundary named) — the guard's own header and the engineering log publish "5 of the 28" for the derived claim population, while the guard's own clean line prints 4 and the tree holds 33.**

`lint-account-matches-tree.mjs:27-29`, added in this commit as the repair for pass 21 finding 8: *"the QUOTED annotations are the registry — and only the quoted form, **which is 5 of the 28**."* Repeated verbatim in the engineering log.

Re-derived over `ANNOTATION_SOURCES`: at `9020a4500` there were 28 marks and 5–6 quoted; at HEAD there are **33** marks and **4** quoted, and `--json` reports `claimsDerived: 4`. Pass 21's numbers were true when it measured them. The author transplanted them into two artifacts inside the commit whose own edits changed both. The guard prints `4 retired claim(s) derived` on every clean run, four lines of output away from a header saying 5. A stale self-count about the machinery's own population, inside the guard whose subject is "the account of itself must match the tree", produced by the repair for a finding about over-stating that same population. The companion figure *"23 of 28 annotations already use that form"* is stale the same way (29 of 33).

**Boundary:** pass 21 graded its own finding 8 — the qualitative version of this same over-statement — *minor*. Under that treatment this drops and my load-bearing count is 2. I count it, because a printed number contradicted by the same file's own output on every run is a different thing from a prose over-reach.

**4. SEVERITY: major (not load-bearing under the stated rule) — the repair for the vacuous clean-case control produced a second vacuous control.**

`it('ACCEPTS a cited review pass whose verdict IS archived')` previously wrote a *novel* pass and created its verdict. The repair changed it to append `As review pass 7 found…` to the real log. Pass 7 is already cited by the untouched fixture. Proven by instrumenting the arm and dumping the derived set: untouched fixture gives `CITED=1..21`; with the test's appended line, byte-identical. The test cannot fail for any reason `passes on the untouched tree` does not already catch. Under the prompt's broader wording this counts load-bearing and my count is 4. I follow pass 21's precedent — while noting the shape: the repair for *"a control that passes because it touches nothing is worse than no control"* shipped another one.

**5. SEVERITY: major (not load-bearing) — two of the four citation forms this repair claims to have added have no test; deleting either leaves the suite green.**

One mutation at a time in a clean clone, restored between: revert the whitespace join → 1 red (exactly the indented-wrap test); neuter the ordinal parse → 1; neuter the verb exclusion → 5; neuter the claim fail-closed → 1; **neuter the plural form → 0**; **neuter the hash form → 0**; cripple the tens table → 1; drop the "of" alternative → 0.

All four *claimed* sabotages reproduce exactly as recorded. But the plural form and the hash form — both announced in this commit as capabilities added — are guard behaviours nothing in this repository can fail on, which is the precise absence the behavioural suite was created for at pass 17.

**6. SEVERITY: minor (bookkeeping; corrects an archived verdict) — pass 21's "the 'fourteen' figure is reproducibly FALSE" is population-dependent and over-stated, and the branch has now committed that over-statement to the archive, the log and the commit message.**

Re-derived independently, per commit state, counting log lines the figure arm would flag: with the four-figure hand list actually configured, 11 at every state. With the six-figure population the authority declares, **14** at `930d8d13d` and `834ecb0b2`, 16 later.

"Fourteen" is exactly reproducible under the six-figure population — the population pass 20 had already ruled the hand list was *narrower than* — at both states where the claim was written. Pass 21 fixed the population by taking it from the commit whose list was the known defect, then recorded a flat *"the author is right and pass 20 is wrong."* The honest statement is that the number is population-dependent: 11 as configured, 14 as declared. Pass 20's hedge was closer to the truth than pass 21 allowed.

**7. SEVERITY: minor — the verb-sense exclusion is wider than its own description and swallows a genuine citation form.** `CITATION_UNIT_RE` includes an "of" alternative, which is not a unit word, against a comment reading *"a following **unit word** or percent sign disqualifies it. Narrow and deterministic, not a guess at intent."* Verified by input: `As pass 99 of this series found…` arms nothing. Dropping each alternative in turn shows only the percent sign is load-bearing for the current tree; the other eleven are speculative, and one of them is a preposition that silences the arm.

**8. SEVERITY: minor — ARM 3 has no fail-closed over an empty population, while both siblings now do.** With an empty archive directory and no citations, ARM 3 computes an empty missing set and prints clean. "One failure teaches every guard" was not swept to the third arm in the commit that applied it to the second. No live instance.

**9. SEVERITY: minor — a citation form the documents actually use evades ARM 3.** The engineering log writes *"across passes 4–7"*. Range and comma-list forms are unparsed. Harmless today because those are filed; it is an escape hatch for a future multi-pass citation whose middle members are unarchived, and the contiguity check only catches a *hole*, not a missing tail.

**10. SEVERITY: nit — the explainer's new section says *"The twenty-first reading found three things."*** Pass 21 recorded **eleven** findings, three of them load-bearing. The three narrated match neither the total nor the load-bearing three. On the reader-facing page.

**11. SEVERITY: nit — the sabotage record's own arithmetic.** *"neuter the verb exclusion → five, the three clean-case controls plus its own test"* — 3 + 1 ≠ 5. There are four clean-case controls in that block; my run reds exactly those four plus its own test.

**12. SEVERITY: nit — the clean line labels a file count as a citation count.** `archivedVerdicts` counts files in the archive directory; the sentence renders it as *"21 **cited** review verdict(s) present"*. Equal today by coincidence.

**No critical findings.**

## REGRESSION-CHECK

| Claim | Verdict | Evidence |
|---|---|---|
| **(a)** indented-wrap regression restored | **PARTIAL** | Plain-indent and list-indent genuinely restored — sabotage reds exactly the indented-wrap test, 1 of 41. Comment-prefixed and blockquote continuations remain invisible, one-line controls fire, and the two artifact sentences pass 21 named as false are unchanged (finding 1). |
| **(b)** citation forms | **NEW-DEFECT** | All announced forms arm; the derived set on the pristine tree is exactly `1..21`, with the percent case correctly excluded. The explainer's closure sentence is corrected to "four pages" (accurate). **But the tens table stops at every round number** (finding 2), and two forms are untested (finding 5). |
| **(c)** verb-sense exclusion | **PARTIAL** | The three cases pass 21 named no longer refuse; sabotaging reds 5 tests. It over-reaches via the "of" alternative (finding 7). |
| **(d)** fail-closed on an empty claim population | **CLEAN** | Reproduced pass 21's emptying: refuses with *"watching NOTHING"*. Sabotage reds exactly its own test. |
| **(e)** clean-case control made real | **NEW-DEFECT** | The fixture genuinely carries the surfaces and the archive; the untouched-tree run now exercises all four arms. Two of the three repaired tests still discriminate. The third was **weakened into vacuity** (finding 4). `tests/` is still not copied, so "every describe block" remains marginally over-stated. |
| **(f)** findings 3, 8, 9, 10, 11 applied | **PARTIAL** | 3: CLEAN, both sentences narrowed and `:844` annotated on the same line. 9: CLEAN, 0 quoted annotations parse out of the lint header. 10: CLEAN, verified by input past the old byte bound. 11: CLEAN in mechanism, proven by the lint firing on itself, undermined by finding 1's wrap hole. 8: narrowed correctly but quantified falsely (finding 3). |
| **(g)** `pass21-verdict.md` archived alone, before, required by the machinery | **CLEAN** | By ancestry: `dec830416` contains exactly one file, ten minutes before the repair. The mechanism genuinely would have refused — with the verdict removed, ARM 3 reports it MISSING. |
| **(h)** no arm narrowed to dodge the arming loops | **CLEAN** | Tested by re-introducing both loops: a literal verdict-file example still arms; a literal ordinal example still arms. Only the prose was reworded. |
| **(i)** 47 steps; "fourteen" false | **PARTIAL** | **47 confirmed independently** — 46 at the earlier states, 47 at `834ecb0b2` and after, 42 on `origin/main`. Pass 20's "46" is wrong; pass 21 is right. The "fourteen" half does **not** hold as stated (finding 6). |

**Passes 9–21 repairs still hold**, with the exceptions named. Full 47-step chain green end-to-end. Four registry guards clean and unchanged. 41/41 behavioural tests green. Archive complete and contiguous `pass1`–`pass21`. **Third consecutive pass in which I could find no defect in the four registry guards** — I probed the fingerprint guard with a closed-ATX duplicate heading (correctly refused) and a tab-indented heading (correctly ignored: a tab is a code block in CommonMark, and the guard's message says "up to three leading spaces", which is exactly what it implements). The two declared known-open reds reproduce exactly and only.

## MECHANISM-CHECK

- **(a) wrap matching — PARTIAL.** Restored for the indentation class. **OPEN** for the prefix class, on a surface this commit added, with two artifacts still asserting universality.
- **(b) citation population — PARTIAL.** Four forms genuinely parse. **OPEN** at every round-ten ordinal, at ranges, and at any citation followed by "of".
- **(c) verb-sense exclusion — CLOSED** for the named cases, **OPEN** in the over-reach direction.
- **(d) empty-claim fail-closed — CLOSED**, and tested. **OPEN** for ARM 3, which the same reasoning covers.
- **(e) clean-case control — PARTIAL.** The fixture is real; one repaired test is now vacuous.
- **(f) findings 3, 9, 10, 11 — CLOSED**, three proven by input. **Finding 8 — PARTIAL**: narrowed correctly, quantified falsely.
- **(g) archive-before-repair — CLOSED**, and verified as *enforced* rather than remembered.
- **(h) population integrity under self-reference — CLOSED.**
- **(i) 47 steps — CLOSED. "Fourteen" — OPEN**, and the record now carries an over-stated correction.

## MY-ACCOUNT-CHECK

**Re-derived by execution:** the branch delta and per-commit file sets; the archive commit's single-file content, ancestry and timestamp gap; the ARM 3 refusal that would have blocked it; the full citation-form matrix (17 probes) and the derived set on the pristine tree, dumped from an instrumented copy; the complete 1–100 ordinal resolution table; every wrap shape (six probes plus one-line controls) including the needle spanning the repair comment's own break; the annotation census at HEAD and at the prior state; the figure derivation and its structural header bound, with enrolment-by-input past the old boundary; the figure-arm hit count at four commit states under two populations; the lint-chain length at six commit states; the empty-claim sabotage; the unit-exclusion alternative-by-alternative test; four claimed sabotages plus four of my own, each in a clean clone, restored byte-identical; the fixture's contents; the archive's 21 files; the four registry guards' live counts; two independent fingerprint-guard probes; the two known-open reds; and the stale `dist/`, traced to a packed hash and a timestamp. I made no edits.

**Carried without re-deriving:** the per-pass load-bearing figures for passes 1–20; the characterisation of findings inside passes 1–19 beyond the passages I quote; the known-open list as supplied, of which I verified four members.

**Discrepancies between the tree and its own records:** the 5-of-28 count; the two unchanged wrap sentences; the "this very comment" claim; the tens-table justification; the "found three things"; **in an archived verdict**, pass 21's flat "reproducibly false" for the fourteen figure; the sabotage arithmetic; and the stale `dist/`, which I attribute rather than count.

## MAGNITUDE-METRIC

**Load-bearing: 3** — findings 1, 2 and 3. Finding 2 is NEW; finding 3 is NEW and produced *by* the repair for pass 21 finding 8; finding 1 is CARRIED in its artifact half with a NEW element.

Under the prompt's broader wording, findings 4 and 5 would also count and this pass would be **5**. Under pass 21's own treatment of its finding 8, finding 3 would drop and this pass would be **2**. I record 3 and name both boundaries.

**Bookkeeping / process findings: 9.**

## TRAJECTORY

Load-bearing, passes 1 to 22: **4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2 3 2 3 3**

**The decline is real, it is now six readings deep, and it is not an artifact of grading.** Against a seventeen-pass plateau of 4–6. Third consecutive pass with no defect in the four registry guards, attacked with shapes nobody has tried. All four claimed sabotages reproduce to the exact test. The archive limb is, for the first time, verified as *enforced*. The populations self-extend by input in both directions I tested. And the author's self-reference discipline held under adversarial test: both arming loops were resolved by rewording prose, and re-introducing either still arms the guard, so nothing was narrowed to buy quiet.

**The generator is unbroken at sixteen consecutive passes, and this pass shows two of its sub-shapes at once.** The first is the one pass 21 named: *a working capability announced while a narrower one ships.* Finding 2 is its purest form yet — the tens table was added with an explicit written rationale about not stopping at a round number, and it stops at every round number.

The second is newer and more troubling for the convergence question: **the repairs are now reproducing the defects they repair.** The fix for "your clean-case control is vacuous" produced a vacuous control. The fix for "you over-state the derived population" published a false count of that population, contradicted by the guard's own output on every run. The findings are genuinely thinner — one carried, one a number, none touching the four registry guards — but the mechanism producing them has not changed.

## CONVERGENCE

**Not met.**

- *Not zero findings; known-opens not required closed; nits not held against it.* I hold none of them against this verdict. I discount findings 4–12 entirely from the metric, do not count the archived-verdict error against the branch, nor the stale `dist/`.
- *Magnitude genuinely declining* — **SATISFIED. I credit it plainly, for the fourth consecutive pass, and the evidence is again the strongest yet.** Six readings at 6, 2, 3, 2, 3, 3. Three consecutive passes with no defect in the four registry guards, this one under two new probe shapes. The archive limb verified as machinery rather than resolution. Four author sabotages reproducing to the exact test, and four of mine adding real information.
- *Remainder converted to expiry-dated named work* — **fails, in the same specific way it has failed since pass 17.** Findings 2 and 3 are not remainder to schedule. They are, again, a closure claimed and not delivered, and again the claim is inside the mechanism built to end that class.

Sixteenth consecutive pass.

## COHERENCE

**No — and the divergence has narrowed to a single axis, but it has changed character, and not for the better.**

The machinery is in the best state of the twenty-two readings. Every arm I attacked refused exactly its own input and nothing else. Four author sabotages and four of mine each reddened precisely the tests they should. The four registry guards are untouched and clean under fresh probes. The 47-step chain is green. The archive is complete, contiguous, filed alone ten minutes before the repair it prompted, and — verified, not asserted — defended by a limb that refuses.

The account still diverges, and every instance is now a claim *about the machinery, written into the machinery's own files*: a guard header publishing a population count its own clean line contradicts; two artifacts, both named as false by the last reviewer, still stating that a wrapped claim is found "across any number of lines", now guarding a surface where the common wrap shape is unfindable; a repair comment naming "this very comment" as a case it fixes, feeding which proves it does not; a commit message justifying a tens table by the property it lacks at every round number; and a reader-facing explainer telling a reader the last reading found three things when it found eleven.

The character shift is this. At pass 21 the divergence was concentrated in the *narrative* layer while the guard files told the truth. At pass 22 the two sharpest divergences are inside the guard itself. The file that exists to make the account match the tree is now the file where the account most reliably does not.

## VERDICT

**reject.** This is the strongest state the branch has been in and that belongs before the refusal: three consecutive passes with no defect in the four registry guards, this time under probe shapes nobody had tried; the archive limb verified as *machinery* for the first time in the series — I removed the verdict and watched the build refuse rather than reading that it would; the derivations self-extending by input in both directions, including past the byte boundary the last reading found; both self-inflicted arming loops resolved by rewording prose rather than narrowing a population, which I confirmed by re-introducing them; all four claimed sabotages reproducing to the exact test in a clean clone; the 47-step chain and the 41-test suite green; and on the one contested number from last cycle, pass 21's "47 steps" is right and I confirmed it. Magnitude is genuinely declining and I credit that clause without qualification, for the fourth consecutive pass. It fails the other clause as the last five passes did. The tens table added this cycle was justified in writing by the exact property it does not have and cannot resolve the ordinal for the thirtieth reading, which is this document's own heading convention; the repair for "you over-state the derived population" published a count of that population which the guard contradicts on every run; the repair for "your clean-case control is vacuous" produced a control that cannot fail; the two sentences the last reading named as false about wrap handling are unchanged while the commit added a surface where they are more false than before; and two of the four citation forms this commit announces have no test at all, so nothing here can fail when they break — which is the absence that started this streak. The next move is small and it is not another population: finish the ordinal table at the round numbers, make the scan strip a leading comment or quote marker before joining, re-derive the two counts in the header from the guard rather than from a reviewer's verdict, give `ACCEPTS a cited review pass` a pass number the fixture does not already cite, and add a sabotage for the plural and hash forms — then correct the two wrap sentences to the rule the scan implements. After that the remainder really is dated, named work.
```
