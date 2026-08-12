# External review pass 23 — reviewer's verbatim final answer

**Filed ALONE and BEFORE the repairs, and required by the machinery.**

Pass 23 recorded load-bearing **3**, credited the magnitude clause as SATISFIED for the **fifth consecutive
pass** — *"and the evidence is again the strongest in the series"* — and found no defect in the four
registry guards for the **fourth consecutive pass**, this time under **twelve** probe shapes including
several never tried (closed-ATX headings new and duplicate, tabs after hashes, tilde fences, CRLF,
four-space indentation, indented ID lines, duplicate article IDs, unclosed fences).

It is also the first pass to say what the next reading should be able to conclude: *"The next move is
smaller than the last one and it is not another population… After that the remainder really is dated, named
work, and I would expect the twenty-fourth reading to be able to say so."*

Run against `b6173109a`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 23 — `echo/window10-deep-property-guards` @ `b6173109a`

**Grading rule declared up front, for comparability.** I keep the definition passes 17–22 used: *a finding is load-bearing if it either (i) leaves a guard unable to refuse an input it claims to refuse, or (ii) leaves a committed artifact asserting something false about the machinery.* Where a different defensible rule changes the count I name the boundary rather than switching metrics silently. Every finding below was reached by execution — input-feeding against file-faithful fixtures built by the same `buildFixture()` the suite uses, or one-mutation-at-a-time sabotage in a sandbox clone. I edited nothing in the review tree.

## FINDINGS

**1. SEVERITY: major (load-bearing; CARRIED class, third consecutive repair, with a NEW element) — the prefix wrap class is still open for the dominant shape of the surface it was built for, and the two "corrected" sentences are themselves written in that shape.**

The repair strips a leading marker and at most ONE whitespace character; the residual run then collapses to a single LEADING space rather than being removed, so the join carries two spaces while every needle carries one. A continuation beginning with a marker plus TWO OR MORE spaces is still invisible. Verified by input, control = the identical claim on one line:

| wrap shape | surface | result |
|---|---|---|
| plain indent, 1 and 2 spaces | eli16.md | **refused** |
| blockquote, 1 space | eli16.md | **refused** |
| block comment, 1 space | lint-account-matches-tree.mjs | **refused** |
| block comment, **3 spaces** | lint-account-matches-tree.mjs | **clean, exit 0** |
| block comment, 2 spaces | lint-account-matches-tree.mjs | **clean, exit 0** |
| line comment, 3 spaces | lint-account-matches-tree.mjs | **clean, exit 0** |
| blockquote, 3 spaces | eli16.md | **clean, exit 0** |
| one-line controls, all | — | refused |

Reproduced with a **real derived matcher**, not a fixture invention: one of the three wordings the guard actually derives, split across a three-space block-comment continuation in the guard's own file, is **missed**; the same wording on one line is **refused**.

The new element, and it is the sharpest instance in this series. That three-space form **is the house indentation of that file's own header**, including the very sentence this cycle added to certify the fix. I retired a guard-only wording spanning that block's line break and the guard **found nothing on its own file**; the control wholly inside one line of the same block **refused at the guard file**. This is pass 22 finding 1's demonstration reproduced after its repair, on the same file, one indentation level deeper.

The artifact half is therefore still false, in both places: the guard header and the engineering log now read *"including a continuation beginning with an indent, a comment marker or a blockquote marker."* The marker-plus-multi-space form begins with a comment marker and is not found. The increment record presents the class as closed with no residual named.

**No live instance:** I swept both scans over all five claim surfaces with a hard-normalising comparator — **0** wordings the guard misses that a correct scan finds. The hole is in coverage, not in the current text.

**2. SEVERITY: major (load-bearing under the stated rule; boundary named) — the transplanted count was removed from ONE of the two artifacts pass 22 named. The engineering log still publishes it, along with its companion.**

The header was swept. The log was not, and the repair commit does not touch either line — both `git blame` to last cycle and are unchanged at HEAD: the "5 of 28" figure inside the findings summary, and the companion "23 of 28 annotations already use that form".

Census re-derived over the guard's exact `ANNOTATION_SOURCES`: **33** marks at `db4a3f4c5` **and** at HEAD; 5 quoted openings; `--json` reports `claimsDerived: 4`, `matchersDerived: 3`. Both figures were false when written and remain false. The explainer tells a reader *"It is to stop writing the number down at all"* while the log writes it down twice.

**Boundary:** pass 21 graded the qualitative version of this over-statement *minor*. Under that treatment this drops and my count is **2**.

**3. SEVERITY: major (load-bearing under the stated rule; boundary named) — the stated reason for leaving ARM 3's fail-closed arm untested is false. The state is reachable in one fixture mutation that corrupts no message template.**

The test file, the commit message and the log all say: *"The state it guards (zero citations AND an empty archive) is structurally UNREACHABLE in this repository: the guard file is itself a citing surface and its own header cites review passes, so the citation set is never empty."*

I reached it. Replace **only the leading block comment** (77 lines, nothing executable, no message template) with a citation-free one, strip citation tokens from the three doc surfaces while keeping their quoted annotations, clear the archive:

```
citedPasses=0  archived=0  claimsDerived=4  matchers=3  exit=1
ARM3 empty-population refusal FIRED: true          ← exactly one failure, its own
message templates intact: all three ✓
```

The recorded obstacle — *"my first attempt stripped citations from the guard's source with a blunt regex and corrupted its message templates"* — was a blunt tool, not a structural fact. Every test in that file operates on a MUTATED FIXTURE, never on "this repository", and the two sibling fail-closed arms are tested by precisely this class of mutation. The arm is genuinely untested — sabotage reds **0** tests — and the disclosure of that is creditable; the reason given for it is not true.

**Boundary:** under a rule counting only "a guard unable to refuse an input it claims to refuse", this drops (the arm *does* refuse when reached) and my count is **1**.

**4. SEVERITY: minor (not load-bearing; NEW, produced by the wrap repair) — the marker strip introduces a false-positive class and an asymmetry between markdown bullet characters.**

Asterisk and hash markers are stripped, hyphen is not. Two SEPARATE asterisk list items, or two SEPARATE hash headings, are now joined into one haystack sentence and reported as a single wrapped claim; byte-identical content written with hyphen bullets is not. Verified by input. The branch's own narrowing control exists because *"a guard that flags correct prose trains its reader to skip it."*

**5. SEVERITY: minor (NOT counted — a new instance inside a declared, dated known-open) — `lint-enforcement-fingerprint.mjs` keeps a private article parser that disagrees with the shared registry core on HTML comments.**

The guard reimplements the population inline and does not strip HTML comments, while the shared core does. Consequences, measured:

- An article commented out with a block HTML comment is a NEW unfingerprinted standard to the fingerprint guard (refuses) and absent to `standards-coverage`. A false refusal, and it falsifies pass 12's archived *"No false positives found: fenced, HTML-commented and 4-space cases stay clean"* — pass 12 evidently probed the one-line form, which I confirm stays clean.
- Sharper: one stray UNCLOSED HTML comment opener inserted mid-document drops the core and `standards-coverage` from **88 articles to 68**, while `lint-registry-self-counts` still prints "(88 articles, 11 families)", `lint-no-duplicate-definitions` still prints "88 article(s)", the fingerprint guard still sees 88, and **every registry guard exits 0**. Twenty constitutional articles leave the coverage population from a one-line typo with the chain green.

I do **not** count this. The class is a declared, dated, tracked sub-obligation — `STD-SUBCOUNTDOWN-registry-populations-diverge`, countdown `2026-09-07` — and it is on the prompt's known-open list. Recorded because the magnitude (20 articles from an unbalanced delimiter) is larger than the instances the registry enumerates, and because the unclosed-comment cause is not among them.

**6. SEVERITY: nit — residual ordinal scope.** The numeric-ordinal form, an intervening adjective, and the nouns verdict/readings/passes resolve nothing. Zero live instances.

**7. SEVERITY: nit — carried bookkeeping, unrepaired and not required.** The sabotage arithmetic ("three clean-case controls plus its own test" ≠ five; there are four), and the explainer's "The twenty-first reading found three things" where pass 21 recorded eleven.

**No critical findings.**

## REGRESSION-CHECK

| Claim | Verdict | Evidence |
|---|---|---|
| **(a)** round ordinals | **CLEAN** | Extracted the table, regex and decoder **from the guard source** (not retyped) and enumerated 1–100: **0 failures** hyphenated, **0** space-separated. End-to-end through the real guard: every round ordinal demands its verdict file. Sabotages isolate exactly their own tests. Residual forms are scope, not defect. |
| **(b)** prefix wrap class | **NEW-DEFECT** | Both claimed tests exist and discriminate — reverting the marker strip reds **exactly** the two new tests and nothing else. But the class is open at marker + ≥2 spaces, which is the house indentation of the file the repair was built for, demonstrated on that file's own certifying sentence, and it adds a false-positive class. |
| **(c)** transplanted count | **PARTIAL** | Header genuinely fixed and the share is now derived and printed on every clean run. The second artifact pass 22 named, and its companion figure, are unchanged. |
| **(d)** preposition removed / percent restored | **CLEAN** | The percent case is clean; a citation followed by "of" arms again. Dropping the percent alternative reds 5 tests — it is load-bearing and working. |
| **(e)** vacuous control repaired | **CLEAN** | The derived set genuinely changes: 22 untouched, 23 with the appended citation. Cite-without-archiving refuses. The pass assertion is contingent on the archive write. |
| **(f)** plural + hash forms tested | **CLEAN** | Each sabotage reds exactly one test, its own. |
| **(g)** ARM 3 arm "deliberately untested, state unreachable" | **NEW-DEFECT** | Untested confirmed. The justification is falsified — reached in one mutation, one failure, templates intact. |
| **(h)** two wrap sentences corrected | **PARTIAL** | Both now name indent / comment marker / blockquote marker. Both remain broader than the scan, and both are written in the unhandled form. |
| **(i)** the "fourteen" figure | **CLEAN** | Re-derived independently, rule extracted from the guard at each state: **11** under the four-figure hand list configured, **exactly 14** under the six-figure declared population, at **both** states where the claim was written. Pass 22 is right; pass 21's flat "reproducibly false" is over-stated; the branch's correction is accurate. |
| **(j)** `pass22-verdict.md` archived alone, before | **CLEAN** | Exactly one file, parent `db4a3f4c5`, direct child `b6173109a`, **9 minutes** earlier. And enforced, not remembered: removing the verdict at HEAD makes the build refuse naming it. |

**Passes 9–22 repairs still hold**, with the exceptions named. 47-step lint chain green end-to-end, 46/46 behavioural tests green, archive complete and contiguous with all 22 genuine reviewer blocks, all rejects. **Fourth consecutive pass in which I could find no defect in the four registry guards** — twelve fresh probe shapes all answered correctly. The two declared known-open reds reproduce exactly and only.

## MECHANISM-CHECK

- **(a) round ordinals — CLOSED** for 1–100 in both compound forms, proven by enumeration and by input. **OPEN** only at declared scope.
- **(b) prefix wrap — PARTIAL.** Closed for marker + exactly one space; **OPEN** at marker + ≥2 spaces, which is the watched surface's own style. Newly **OPEN** in the false-positive direction.
- **(c) derived count — PARTIAL.** Closed in the guard, **OPEN** in the engineering log, twice.
- **(d) unit exclusion — CLOSED**, both directions, covered by sabotage.
- **(e) clean-case control — CLOSED**, and proven contingent.
- **(f) plural + hash coverage — CLOSED.**
- **(g) ARM 3 fail-closed — the arm is CLOSED in code and OPEN in coverage; the *justification* is falsified.**
- **(h) wrap sentences — PARTIAL.**
- **(i) "fourteen" — CLOSED**, and the record now states it correctly.
- **(j) archive-before-repair — CLOSED**, verified as enforcement.

## MY-ACCOUNT-CHECK

**Re-derived by execution:** the branch delta and per-commit file sets; the archive commit's single-file content, ancestry and 9-minute gap; the ARM 3 refusal that enforces it; the complete 1–100 ordinal resolution table under both compound forms plus five other real-English forms, from machinery extracted out of the guard source; twelve wrap shapes end-to-end with one-line controls, including a real derived matcher and two needles spanning the guard's own corrected sentence; the full derived matcher set; the annotation census per file at HEAD and at the prior state; a hard-normalising live-instance sweep over all five claim surfaces (0 misses); nine one-at-a-time sabotages in a clean sandbox, restored between; the ARM 3 empty-population reachability mutation with template-integrity checks; the vacuous-control discrimination in both directions; the "fourteen" figure at five commit states under two populations, with the matching rule extracted from the guard at each state; twelve registry-guard probe shapes; the population census across four parsers under three HTML-comment shapes; the 47-step chain and its exit code; the 46-test suite; both known-open reds; the 22 archived verdicts' contents and dispositions; and the stale `dist/`, attributed rather than counted.

**Carried without re-deriving:** the per-pass load-bearing figures for passes 1–21; the characterisation of findings inside passes 1–20 beyond the passages I quote; the refusal-arm coverage figure of 22 of 84 arms and its shape; the known-open list as supplied, of which I verified five members.

**Discrepancies between the tree and its own records:** the two surviving stale population counts in the engineering log; the two wrap sentences, still broader than the scan and still written in the shape it cannot read; the "structurally unreachable" justification for the untested arm; the increment record presenting the prefix class as closed; the sabotage arithmetic; the explainer's "three things"; and — not counted — the four-way article-population disagreement and the stale `dist/`.

**Errors in the prompt itself:** item (c) presents the transplanted-count repair as done and asks whether any stale count remains; two do, in the same artifact pass 22 named. That is the check the prompt asked for rather than a misstatement. I found no false statement in the prompt's other items, and no error in `pass22-verdict.md`.

## MAGNITUDE-METRIC

**Load-bearing: 3** — findings 1, 2 and 3. Finding 1 is CARRIED in class with a NEW element (the certifying sentences are themselves counter-examples). Finding 2 is the unswept half of a repair certified as applied. Finding 3 is NEW.

Boundaries where a different defensible rule changes the count: exempting stale prose counts as bookkeeping — pass 21's own treatment — drops finding 2 → **2**. Narrowing to "a guard unable to refuse an input it claims to refuse" drops findings 2 and 3 → **1**. Counting finding 5 rather than treating it as an instance of a dated known-open → **4**.

**Bookkeeping / process findings: 4.**

## TRAJECTORY

Load-bearing, passes 1 to 23: **4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2 3 2 3 3 3**

**The decline is real, it is seven readings deep, and it is not an artifact of grading.** Against a seventeen-pass plateau of 4–6, the last seven readings are 6, 2, 3, 2, 3, 3, 3 — four consecutive at 3 or below with no upward step. Fourth consecutive pass with no defect in the four registry guards, this time under twelve probe shapes including several nobody has tried. Every claimed sabotage reproduces to the exact test; five of my own each isolate exactly what they should. Every claimed repair is at least partly delivered, and four of ten are fully delivered and covered.

**But the generator is unbroken at seventeen consecutive passes, and it is now operating on a smaller surface with the same reliability.** All three load-bearing findings are the same shape the streak has produced since pass 7: *a closure claimed and not delivered.* Two of them are the incomplete halves of the two repairs this very cycle certified as applied — the wrap fix that reaches one space and not three, and the count-deletion that swept one artifact of two. The third is new and, in a way, the most telling variant yet: the one item the author explicitly declined to close was declined on a stated impossibility that took a single mutation to falsify. The class has shrunk from *the fix opens a hole* through *the fix reproduces the defect it repairs* to *the fix is applied to a proper subset of what it certifies* — narrower each cycle, and still generating.

## CONVERGENCE

**Not met.**

- *Not zero findings; known-opens not required closed; nits and machinery-harmless bookkeeping not held against it.* I hold none of them against this verdict. I discount findings 4–7 entirely, do not count the registry-population divergence (dated and tracked), do not count pass 12's archived error against the branch, and attribute rather than count the stale `dist/`.
- *Magnitude genuinely declining* — **SATISFIED. I credit it plainly, for the fifth consecutive pass, and the evidence is again the strongest in the series.** Seven readings at 6, 2, 3, 2, 3, 3, 3. Four consecutive passes finding nothing in the four registry guards, this one under twelve fresh shapes. Five of ten repairs closed outright and covered by sabotage that isolates to the exact test. The archive limb enforced, not remembered. The ordinal population now self-extends across its whole declared range in both compound forms.
- *Remainder converted to expiry-dated named work* — **fails, in the same specific way it has failed since pass 17.** Findings 1, 2 and 3 are not remainder to schedule. Finding 1 is decisive on its own: I fed the guard a wording spanning the line break of the sentence added *this cycle* to certify that exact shape is handled, and it found nothing, while the control inside one line fired. When the artifact certifying a fix is a live counter-example to the fix, the second clause cannot be met at any count.

Seventeenth consecutive pass.

## COHERENCE

**No — but the divergence has narrowed again, and this time it is narrower in kind as well as in count.**

The machinery is in the best state of the twenty-three readings. Every arm I attacked refused exactly its own input and nothing else. Nine sabotages each reddened precisely the tests they should, including the two forms pass 22 found untestable. The four registry guards are clean under closed-ATX headings both new and duplicate, tabs after hashes, tilde fences, CRLF, 4-space indentation, indented ID lines, duplicate article IDs and unclosed fences. The 47-step chain is green, the 46-test suite is green, the archive is complete, contiguous, filed alone nine minutes before the repair it prompted, and defended by a limb that genuinely refuses.

The account still diverges, and every instance is again a claim *about the machinery, written into the machinery's own files*: two sentences saying a comment-marked continuation is found, written in the comment-marked continuation style that is not found; an engineering log still publishing the population count the same cycle's guard header stopped publishing, beside a paragraph explaining why publishing it is wrong; a test-file comment recording a state as structurally unreachable that one mutation reaches.

The character shift from pass 22 is worth stating precisely, because it cuts both ways. Pass 22 found the two sharpest divergences *inside the guard file*. At pass 23 the guard's **code** is right about everything I could put to it except one whitespace boundary; the divergences are back in the **prose**, and the prose in question is the prose that certifies the code. The file that exists to make the account match the tree is no longer the file where the account most reliably fails — but it is still a file whose header is a live counter-example to its own header.

## VERDICT

**reject.** This is the strongest state the branch has been in, and that belongs before the refusal: four consecutive passes with no defect in the four registry guards, this one under twelve probe shapes including several never tried; the ordinal population now resolving every form of every number from one to a hundred, verified by enumeration against machinery extracted from the guard rather than retyped; the percent exclusion restored and the preposition genuinely gone, with a citation followed by "of" arming again; the vacuous control now provably contingent on its own archive write; the plural and hash forms each isolating to exactly one test under sabotage; the archive filed alone nine minutes before its repair and enforced by a limb I watched refuse; the 47-step chain and 46-test suite green; and on the one contested number carried in from last cycle, pass 22 is right and pass 21 over-stated — I re-derived 11-as-configured and exactly 14-as-declared at both states where the claim was written, and the branch's correction of its own endorsement is accurate. Magnitude is genuinely declining and I credit that clause without qualification, for the fifth consecutive pass. It fails the other clause as the last six passes did, and the failure is concentrated rather than diffuse: the wrap repair closes the marker-plus-one-space case and leaves marker-plus-three, which is the indentation of every wrapped sentence in the file the repair exists to cover — demonstrated by retiring a wording that spans that file's own certifying sentence and watching the guard find nothing while the one-line control fired; the repair for "you transplanted a count into two artifacts" swept one artifact and left the other, plus its companion figure, untouched and false in the same commit whose record says the fix is to stop writing the number down at all; and the one arm knowingly left untested was left on a stated impossibility that a single fixture mutation falsified, cleanly, with one failure and no corrupted template. The next move is smaller than the last one and it is not another population: make the marker strip consume the whole leading run rather than one space, delete the two stale counts from the engineering log, write the ARM 3 empty-population test the way its two siblings are written — replace the header comment, do not regex the source — and then narrow the two wrap sentences to whatever the scan actually implements after the first fix. After that the remainder really is dated, named work, and I would expect the twenty-fourth reading to be able to say so.
```
