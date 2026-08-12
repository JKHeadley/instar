# External review pass 24 — reviewer's verbatim final answer

**Filed ALONE and BEFORE the repairs, and required by the machinery.**

Pass 24 recorded load-bearing **2** — the series FLOOR, tying passes 18 and 20 — credited the magnitude
clause as SATISFIED *"for the sixth consecutive pass, and I credit it without qualification"*, and found no
defect in any refusal arm of the four registry guards for the **fifth consecutive pass**. It reports no
critical finding for eight consecutive passes, and computes the series in thirds: passes 1–8 average 4.13,
9–16 average 4.63, **17–24 average 3.00**.

Its close is the nearest this work has come to acceptance: *"A twenty-fifth reading that finds only nits
would meet both clauses, and on this trajectory I think it can."*

It rejected on ONE substantive finding, and it is the streak's signature at its narrowest: the repair for a
finding pass 23 had graded **minor, not load-bearing, and did not prescribe** traded a false-positive class
with ZERO instances in this corpus for a false-negative class with TWENTY-TWO — demonstrated on a real
committed line. Run against `79bcbd48c`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 24 — `echo/window10-deep-property-guards` @ `79bcbd48c`

**Grading rule, declared up front (the one passes 17–23 used, kept for comparability):** a finding is load-bearing if it either **(i)** leaves a guard unable to refuse an input it claims to refuse, or **(ii)** leaves a committed artifact asserting something false about the machinery. Where a different defensible rule changes the count I name the boundary rather than switching metrics. Everything below was reached by execution — one-mutation-at-a-time sabotage in a sandbox clone, and input-feeding against the real corpus. I edited nothing in the review tree; `git status` is empty and HEAD is unmoved.

## FINDINGS

**1. SEVERITY: major (load-bearing; NEW, produced by pass 23's repair (b)) — the file-type continuation rule closes a class that occurs ZERO times in this corpus and opens one that occurs 22 times. Both certifying sentences give a reason the corpus falsifies.**

The repair decided continuation markers by file type: in markdown, blockquote only. The stated justification, in the guard header and the engineering log, is *"It may NOT begin with a markdown list bullet or heading marker: those start a new item rather than continue one."* Measured against the three tracked markdown surfaces:

| shape | count |
|---|---|
| markdown star-bullet list items (the class the repair closes) | **0** |
| star-leading lines total (eli16 + side-effects) | 27 |
| …of those, genuine wrapped-sentence continuations (preceded by a non-blank line) | **22** |
| consecutive star-leading pairs (the joined-bullets shape) | 5 — **all 5 are continuations, none is a bullet** |

The docs use hyphens for bullets (never stripped by either version), double-star for paragraph leads (blank-line-separated, so they cannot join under either version), and single star for emphasis **opening a continuation line**. Verified on a **real corpus boundary**, not a fixture invention, at `upgrades/side-effects/…:352/353`. Retiring a wording spanning that wrap:
* shipped rule → `exit 0`, **clean**; the live unannotated retired claim at `:352` is invisible.
* the pass-22 rule this repair replaced → `exit 1`, refused at `:352`.

Reproduced identically on a synthetic instance of the same shape. **No live instance** with the three currently-derived matchers — I swept both scans over all five claim surfaces with a hard-normalising comparator: 0 wordings the shipped scan misses that the pass-22 scan finds. That is exactly the standing pass 23 recorded for its own finding 1, which it graded major.

Two aggravating details. First, pass 23 graded this class **minor, explicitly NOT load-bearing**, and did **not** prescribe fixing it — its four prescribed moves were the whole-run strip, the two stale counts, the ARM 3 test, and narrowing the two sentences. The unprescribed fifth move is the one that regressed. Second, the implementation is **broader than its own certifying sentence**: the sentence excludes "list bullet or heading marker"; the code excludes every non-blockquote opener, emphasis included.

Closable in one character class, verified by execution: a bullet is marker+whitespace and never continues; an emphasis run is marker+non-space and does. Under that rule **all 49 tests pass, including both of pass 23's new tests**, and the real corpus boundary above is caught.

**2. SEVERITY: minor (load-bearing under clause (ii); boundary named) — the increment record quotes pass 23 inside quotation marks with the text altered.**

The engineering log writes, in italics and quotation marks, a version of pass 23's closing sentence with two substantive alterations, presented as verbatim, in the document whose thesis is that the account must match the material. The *reason* is disclosed and legitimate — a literal ordinal would arm ARM 3 against a verdict that does not exist — but the honest forms are a bracketed elision or a paraphrase outside quote marks. The eli16 companion paraphrases outside quotes and is clean; the log did not.

**3. SEVERITY: nit (not load-bearing) — three prose corruptions introduced by this commit, two of them inside emitted failure messages.**

* the guard header — "That asymmetry is deliberate and is the whole of the rule; **it starts.**" The inserted sentences displaced the tail of the sentence above; the orphaned "starts." was left behind.
* the ARM 1 failure message — "This is the arm that caught **review an earlier reading's** finding". The pass number was replaced, the word "review" was not.
* the footer printed on **every** failing run — "because a reading **found found** that both hand-transcribed lists…". I observed it four times in this review's own runs.

The prompt asks explicitly whether any message template was weakened: **both** edited templates are now ungrammatical. Meaning stays recoverable in all three, so none misleads machinery.

**4. SEVERITY: nit (CARRIED, not new) — `ANNOTATION_SOURCES` holds 6 distinct files as 7 entries; the refusal message publishes "7 source file(s)".**

The guard file appears twice — once via `CLAIM_SURFACES`, once appended alongside `COUNTDOWN_GUARDS`. Behaviour is unaffected (a Set dedupes), but the guard prints a self-count one higher than the truth, in a branch whose sibling guard exists because "a count about itself must be true". Introduced at the pass-20 repair; passes 21–23 did not reach it. It sits inside `lint-registry-self-counts.mjs`'s **declared** limit 3, so it is a declared blind spot rather than a hidden one.

**5. SEVERITY: nit (a defect in an archived verdict, not in the branch) — pass 23's finding 2 publishes "5 quoted openings"; the reproducible figure at the commit it reviewed is 4.**

At `b6173109a` the guard's sources carry **33** marks (matching pass 23) but exactly **4** quoted-form openings — which is what `claimsDerived: 4`, quoted in the same paragraph, already implied. Credit where it is due: the branch did **not** propagate the figure. It deleted the counts rather than restating them, which is the correct handling of an archived verdict that must remain verbatim.

**6. SEVERITY: nit — the two dev-decision artifacts certify a proper subset of the commit.** Both record one file in scope while the commit changed six. The declared basis is staged-in-scope additions plus deletions, so this is the gate reporting what was staged when it ran rather than a defect — recorded because the shape (a record describing less than what shipped) is the branch's own theme.

**No critical findings.**

## REGRESSION-CHECK

| Claim | Verdict | Evidence |
|---|---|---|
| **(a)** whole-run marker strip; three-space test; redundancy removed | **CLEAN** | Marker pattern carries no trailing whitespace class; the caller's second trim is the sole post-marker mechanism. Sabotage A1 (delete that trim) reds 3 tests including the three-space one. Sabotage A2 (restore the exact pass-22 line) reds **exactly** the two new tests and nothing else. Live probe: retiring a wording spanning the guard's own header line-break now **refuses** — the arm can read the sentence certifying it can. I also reconstructed the author's claimed intermediate and confirmed the self-report: **neither** single sabotage reds the three-space test. The masked-control diagnosis is real and the removal was the right call. |
| **(b)** file-type continuation markers | **NEW-DEFECT** | Both directions of the *claimed* property hold — separate markdown bullets are not joined (sabotage B isolates to exactly that one test), and indent / blockquote / comment continuations still join. But see finding 1. |
| **(c)** both stale counts deleted, reason stated in place | **CLEAN** | No population count remains on any tracked surface. Re-derived at HEAD: **33** marks, **4** quoted openings, **4** distinct wordings, **3** matchers, 1 skipped — matching `--json` and the clean line. |
| **(d)** ARM 3 empty-population test | **CLEAN** (with the finding-3 caveat) | Sabotaging the refusal reds **exactly one** test, its own. The mutation reaches the empty state genuinely. Templates were not weakened in scope, but two were left ungrammatical. Drift is fail-loud. |
| **(e)** the four wrong attempts absent from the final form | **CLEAN** | Shebang preserved and re-prepended; body sliced **after** the terminator; the discriminator is the leading comment marker, not backticks; replacement tokens contain none of the matched nouns and no digit, so none re-resolves case-insensitively. |
| **(f)** both wrap sentences narrowed | **PARTIAL** | The positive half is now exact in both places. But both attach a justification false for **every** star-leading line in this corpus; the implementation excludes more than the sentence enumerates; and the guard's copy is a broken sentence. |
| **(g)** `pass23-verdict.md` archived ALONE and BEFORE | **CLEAN** | Exactly one file, 171 insertions, **13m27s** before the repair, and its direct parent. Enforced, not remembered: removing the verdict makes the guard refuse, naming it. |
| **(h)** ARM 3 reworded, not narrowed | **CLEAN on the arm; see finding 2** | Every citation regex and ordinal table is **byte-identical** to the prior commit. The arm was not touched. The prose was — and the reword became a misquotation. |

**Passes 9–23 repairs still hold**, with the exception named in finding 1. 47-step lint chain green end-to-end. 49/49 behavioural tests green; chain-completeness 3/3. Archive complete and contiguous, all 23 files genuine reviewer blocks, **23 rejects, 0 accepts**. Three sabotages, each isolating what it should. The two declared known-open reds reproduce **exactly and only**. I re-derived the stale-`dist/` attribution myself rather than carrying it: the asset predates the last registry commit by 42 minutes, and CI builds fresh. Not a branch defect.

## MECHANISM-CHECK

| Repair | Mechanism |
|---|---|
| (a) whole-run strip | **CLOSED.** One mechanism, one sabotage, one red — verified in both directions, including against the reconstructed redundant intermediate. |
| (b) file-type markers | **OPEN.** The mechanism decides on the marker *character* alone, which cannot distinguish a bullet from an emphasis run — the two things that share that character in this corpus, at a 0:22 ratio against the case it optimised for. |
| (c) count deletion | **CLOSED for these two artifacts; PARTIAL as a class.** Nothing refuses a transcription. |
| (d) ARM 3 empty-population test | **CLOSED.** Sabotage-isolated to one test, and fail-loud against the drift that would vacate it. |
| (e) the four wrong attempts | **CLOSED** for each named defect; not generalised into any mechanism. |
| (f) wrap sentences | **PARTIAL.** Nothing checks a *justification* against the corpus it describes, which is precisely how finding 1 shipped certified. |
| (g) archive-before-repair | **CLOSED and mechanical.** ARM 3 refuses on removal — I fired it. |
| (h) forward-reference reword | **PARTIAL.** Nothing binds a quoted string to the archived verdict it quotes, which is what let finding 2 through. |

## MY-ACCOUNT-CHECK

**Re-derived by execution:** branch identity and the 68-commit delta; the 23-file archive and that every file is a genuine reviewer REJECT (0 accepts); (g) ancestry and timing; all three sabotages and their isolation sets; the exact-pass-22-restore control; the reconstructed redundant intermediate and its two single-sabotage non-reds; the guard reading its own three-space header wrap; the corpus census (0 bullets / 27 star-lines / 22 continuations / 5 consecutive pairs all continuations); the real-boundary false negative and its pass-22 control; the live-miss sweep (0); the annotation census (33/4/4/3); the absence of any remaining population count; every remaining code-line citation; ARM 3 enforcement by removal; the full lint chain exit code; the 49+3 tests; both known reds; the `dist/` staleness attribution; and the candidate fix.

**Carried without re-deriving:** the contents of passes 1–22 beyond spot-checks; the individual dating of every known-open item; the refusal-arm coverage figure; and an independent audit of the other three guards beyond running them green.

**Discrepancies between the tree and its own records:** the exclusion justification contradicted by the corpus; the misquotation inside quotation marks; the sentence fragment; two ungrammatical emitted messages; "7 source file(s)" for 6 files; pass 23's irreproducible "5 quoted openings" — correctly not propagated; and the dev-decision artifacts certifying 1 file of 6. The carried nit pass 23 named is still present, as pass 23 said it would be — declared not-required.

## MAGNITUDE-METRIC

**Load-bearing count: 2** — findings 1 and 2.

Boundaries: reading clause (ii) strictly as *"false about the machinery"* rather than *"checkably false in a committed artifact"* drops finding 2 → **1**. Counting a guard's own emitted self-count as machinery promotes finding 4 → **3**; pass 21 graded that shape minor and I follow it. If one holds that a guard's printed text is part of its account, finding 3c promotes → **4**; I do not, because the meaning survives.

Finding 1 alone would be **major** on any of these rules.

## TRAJECTORY

`4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2 3 2 3 3 3` → **2**

Passes 1–8 average 4.13; passes 9–16 average 4.63; passes 17–24 average **3.00** — the lowest-magnitude eight in the series, and my 2 ties the series floor set at passes 18 and 20. Composition has shifted further than the count: no critical findings for eight consecutive passes, **five** consecutive passes with no defect found in the four registry guards' logic, and the residue is now nits and account/prose. The decline is real and it is not an artifact of the metric.

But the sequence has a second property that has not changed at all: **every one of the last eighteen readings, including this one, found a new load-bearing defect inside the immediately preceding reading's repair.** That is the blocking condition, and it is untouched.

## CONVERGENCE

**"The finding stream's MAGNITUDE is genuinely declining" — SATISFIED, for the sixth consecutive pass, and I credit it without qualification.** The count is at the series floor, no critical finding in eight passes, the guards themselves survived a fifth consecutive pass, and the three repairs pass 23 actually prescribed are all clean and all proven by sabotage. The masked-control diagnosis is genuinely good work: I reconstructed the state the author describes and confirmed that neither single sabotage would have redded the test — a failure mode most reviewers never look for, self-found, and the author removed the redundancy rather than the test.

**"With the remainder converted to expiry-dated named work" — NOT SATISFIED.** Finding 1 is not dated named work. It is a fresh, undated, unnamed capability regression, introduced by the immediately preceding repair, in the exact class this branch has been failing on for eighteen passes: a fix that certifies more than it delivers. Three specific things make it more than bookkeeping. It closes a class with **zero** instances in the corpus and opens one with **twenty-two**. It is demonstrated on a **real** corpus line, not a fixture. And it ships with a printed justification that is false of every single star-leading line in the documents the guard watches, so a reader auditing the exclusion would be reassured by a sentence the corpus contradicts.

I want to be explicit that I am not rejecting reflexively, and I considered accepting seriously. The strongest case for accept is that finding 1 has **no live instance** and the criterion does not demand zero findings. I decline it for the reason pass 23 declined the identical standing on its own finding 1: a coverage hole in the wrap matcher is exactly what the last three passes each found and each repair each re-opened one level deeper, and calling the fourth instance "dated named work" would be converting a live regression into a schedule by relabelling.

The move from here is genuinely small and I verified it runs: change the markdown branch so a bullet (marker+whitespace) never continues and an emphasis run (marker+non-space) does, which passes all 49 tests including both of pass 23's new ones and catches the real boundary; fix the three sentence fragments; and either re-quote pass 23 accurately with a bracketed elision or drop the quotation marks. That is four edits, none of them a population, none of them a new mechanism.

## COHERENCE

The repository's account of itself is closer to its machinery than at any prior pass, and the remaining divergences are narrow and nameable: the wrap rule's stated reason is falsified by the corpus it governs; the implementation is broader than its own sentence; a quotation of an archived verdict is altered inside quote marks, in the document whose thesis is that quotations must match — notably the *guard* would not catch this, since ARM 3 checks that a cited verdict exists, never that a quoted sentence matches it; three sentences in the guard are broken, two printed to a developer at the moment a refusal fires; the guard's own refusal publishes "7 source file(s)" for 6 files; and an archived verdict carries an irreproducible census which the branch correctly neither corrected nor propagated — that is the account behaving *well*, and it is worth saying so.

Everything else agrees, verified by running it.

## VERDICT

**reject.** This is the strongest state the branch has been in and that belongs first: the magnitude clause is satisfied for the sixth consecutive pass at the series floor, the four registry guards survived a fifth consecutive reading without a defect in any refusal arm, all three of pass 23's prescribed repairs are clean and sabotage-proven, the masked-control finding was self-diagnosed and correctly resolved by deleting the redundancy rather than the test, the archive discipline held mechanically, and the 47-step chain and 49-test suite are green with only the two declared reds. It fails the second clause, as the last seven readings did, on one finding that is the streak's signature at its narrowest: the repair for a finding pass 23 graded *minor and not load-bearing*, and did not prescribe, traded a false-positive class with **zero** instances in this corpus for a false-negative class with **twenty-two**, demonstrated on a real committed line where the shipped guard reports clean and the rule it replaced refuses — and shipped certified by a sentence the corpus falsifies. The remainder after that really is dated, named work; this one is not, and the fix is four small edits I verified pass the whole suite. A twenty-fifth reading that finds only nits would meet both clauses, and on this trajectory I think it can.
```
