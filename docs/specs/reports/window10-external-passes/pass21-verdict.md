# External review pass 21 — reviewer's verbatim final answer

**Filed ALONE and BEFORE the repairs — and this time the machinery required it.** ARM 3 of
`lint-account-matches-tree.mjs`, added in the previous commit, refuses the build when a tracked surface
cites a review pass whose verdict is not on disk. Writing this increment's records cites pass 21, so the
build fails until this file exists. The eleventh lapse was not available.

Pass 21 recorded load-bearing **3** — two NEW (both inside the previous commit's repair), one CARRIED from
pass 20 finding 1. It credited the magnitude clause as satisfied for the **third consecutive pass** and
"on the strongest evidence yet", and reported that for the second consecutive pass it could find no defect
in the four registry guards.

It also found **two errors in pass 20's own archived verdict**: the lint chain has 47 steps, not 46; and
pass 20 recorded the "fourteen lines" figure as *"unverifiable rather than false"* when it is reproducibly
false — 11 at every candidate state across the whole window pass 20 said made it unverifiable. On that
point pass 21 records: *"the author is right and pass 20 is wrong."* Run against `9020a4500`. Exploration
logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 21 — `echo/window10-deep-property-guards` @ `9020a4500`

**Grading rule declared up front, for comparability.** I keep the definition passes 17–20 used: *a finding is load-bearing if it either leaves a guard unable to refuse an input it claims to refuse, or leaves a committed artifact asserting something false about the machinery.* Where the prompt's broader wording ("a guard whose verdict is unsound") would change a count, I say so explicitly rather than silently switching metrics.

## FINDINGS

**1. SEVERITY: major (load-bearing) — the rewritten scan cannot find a wrapped claim whose continuation line is indented, which is the dominant wrap shape in the documents it watches; two artifacts state the opposite; and this is a capability REGRESSION from the version pass 20 reviewed.**

`scripts/lint-account-matches-tree.mjs:191` builds the haystack as `` `${line.replace(/\s+/g,' ')} ` ``. Leading indentation collapses to *one* space and the previous line has already contributed a trailing space, so the join is **two** spaces while every needle is normalised to single spaces.

Reproduced in a sandbox holding the real files, with `a wholly invented retired wording` supplied as the annotation payload:

| input | result |
|---|---|
| `As established, a wholly invented` / `retired wording is how it works.` | refused at `eli16.md:2` |
| `- As established, a wholly invented` / `··retired wording is how it works.` | **clean, exit 0** |

The version pass 20 reviewed (`834ecb0b2`) evaluated `` `${line} ${next}`.replace(/\s+/g,' ') ``, which collapses the continuation's indentation. Run against the identical indented input with `six major findings`: **old script exits 1, new script exits 0.** The repair that claimed to *strengthen* wrap handling removed a case the previous version caught.

Both artifacts assert the property the code lacks:
- `lint-account-matches-tree.mjs:36-38` — *"matched whole, so a claim wrapped across any number of lines is found exactly once at the line where it starts."*
- `upgrades/side-effects/…md:2177-2178` — same sentence.

No live instance today: I built a variant of the guard changing only `line.replace(…)` to `line.trim().replace(…)` and ran it against the pristine tree — clean. So this is a reachable hole with an accurate negative result, not a hidden violation.

**2. SEVERITY: major (load-bearing) — ARM 3's citation population is narrower than the class its three artifacts name, and the reader-facing explainer states the arm's trigger in a form the arm cannot parse.**

`eli16.md:1367-1369` (new in this commit), closing the paragraph about the limb that lapsed ten times:

> *"It is now impossible: the moment I write **"the twentieth reading found…" anywhere**, the build fails until that reading's verdict is on disk. The sentence creates the obligation. **No promise left in it.**"*

Verified by input, appending to the real `eli16.md`:

| appended sentence | armed? |
|---|---|
| `As review pass 21 found, the list was short.` | **yes** (exit 1) |
| `The twenty-first reading found the guard was blind.` | no |
| `## Twenty-first reading: what it found` | no |
| `Passes 21 and 22 both rejected.` | no |
| `Pass #21 rejected.` | no |
| `External review pass21 rejected.` | no |
| the same citation placed in `lint-account-matches-tree.mjs`'s own header | no |

The ordinal-word form is `eli16.md`'s **house convention** — 21 ordinal-"reading" citations against 3 numeric `pass N` citations, including the section heading two paragraphs above the sentence itself (`## Twentieth reading: I had written the list by hand, twice`). The plural form is an idiom the tracked surfaces already use five times (*"Passes 6 and 7 are now archived too."*, *"Passes 12 and 13 run against this exact state."*). And `CITING_SURFACES` excludes the lint's own header, which is where the prescribing pass has been narrated every increment (its current header cites pass 19 and pass 20 nine times).

The lint's own MEASURED clause (`:53`) says *"every review pass **the tree** CITES"*; the log (`:2185-2186`) says *"the moment **an artifact** writes…"*. Three surfaces is not the tree. Mitigation, stated fairly: the engineering log's own idiom (`Pass 20: REJECT…`) **does** arm the guard, so a real working path exists — but the eleventh lapse remains reachable through the explainer's own convention, and the reader-facing sentence is false as written.

**3. SEVERITY: major (load-bearing, CARRIED — pass 20's finding 1, third element, unapplied) — the two artifacts asserting the general figure rule are untouched, and there is a live unannotated retired figure on the reader-facing page.**

`git diff a5fa027ac..HEAD` shows neither of these lines was touched:
- `eli16.md:1309-1310` — *"no retired figure may sit on a page a person reads unless it is explicitly marked as retired."*
- `upgrades/side-effects/…md:2067` — *"no superseded figure on a reader-facing surface without an explicit `[SUPERSEDED …]` annotation."*

The derived population is exactly the six numerals the cited authority forbids, which the arm now covers correctly. But the tree's own annotations retire more than six figures: `eli16.md:517` annotates *"all four are retired measurements … 62%, 54%, **63%**, **92%**"*, and `:935` adds *"92% versus **93%**"*. Verified by input against the real reader-facing surface — appended, unannotated:

| figure | lint |
|---|---|
| `178`, `62%`, `194`, `104` | exit 1 |
| `63%`, `92%`, `93%`, `102` | **exit 0** |

And a live instance exists: **`eli16.md:844`** — *"The same measurement appeared as both **92%** and **93%** two sentences apart in one paragraph"* — unannotated, on the reader-facing page, 465 lines above the sentence that tells the reader this cannot happen. The same class of mention is annotated at `:517` and `:935`.

**4. SEVERITY: major — the claim arm has no fail-closed check over an empty derived population, while its sibling figure arm has one *and a dedicated test*.**

`deriveFigures()` pushes a refusal when the authority states no triple (*"this arm is now watching NOTHING, which is exactly the alive-but-inert shape"*), and `it('refuses rather than reporting clean when the authority states no retired triple')` covers it. `deriveClaims()` pushes nothing. Sabotage: I rewrote every `[SUPERSEDED — "…"]` in the six source files to the unquoted form (ordinary prose editing — 23 of the 28 annotations in the tree already use that form). Result:

```
claimsDerived 0, matchersDerived 0 · failures 0 · exit 0
"…0 retired claim(s) derived from the tree's own annotations (0 matcher(s), 0 skipped…)"
```

The claim registry lives in one paragraph of `upgrades/side-effects/…md:2029-2037` — a file the guard also *watches*, so a future increment rewriting that paragraph silently empties the arm while printing clean. Not load-bearing today (3 matchers, arm fires), but it is the exact shape this file's header names.

**5. SEVERITY: minor — ARM 3 refuses correct prose.** The citation regex `\b(?:review\s+)?pass\s+(\d{1,3})\b` reads "pass" used as a verb. Verified by input on the real `eli16.md`:

| appended (all correct English) | result |
|---|---|
| `The tests pass 100% of the time now.` | `pass100-verdict.md is MISSING` |
| `It took a second pass 30 minutes later.` | `pass30-verdict.md is MISSING` |
| `The suite must pass 37 checks before merge.` | `pass37-verdict.md is MISSING` |

The bite only lands when the number exceeds the archive — i.e. exactly the numbers that occur in prose. The author's own narrowing control exists because *"a guard that flags correct prose trains its reader to skip it"*. Under the **prompt's** broader wording ("a guard whose verdict is unsound") this would count load-bearing; under the series' metric it does not.

**6. SEVERITY: minor — the behavioural suite's untouched-tree control is vacuous for three of this lint's four arms.** I replicated `buildFixture()` exactly and ran the lint with `--json` inside it:

```
archivedVerdicts 0 · readerFacingSurfaces 0 · claimSurfaces 0 · matchersDerived 0
```

`buildFixture()` copies `scripts/` and five `docs/` files; it copies no `upgrades/`, no `docs/specs/`, no `tests/`. So `it('passes on the untouched tree')` exercises ARM 1 and the figure-authority fail-closed check only. The file's declared discipline — *"ALWAYS RUN THE CLEAN CASE. … Every describe block asserts the untouched fixture passes, so a refusal proves discrimination rather than noise"* — proves nothing for ARM 2a/2b/3. (Their discrimination *is* covered, by three dedicated ACCEPT tests; the over-statement is in the fixture's name and the header's claim.)

**7. SEVERITY: minor — same-line amnesty.** One `[SUPERSEDED` on a line releases *every* retired claim on that line, including unrelated ones. Verified: `[SUPERSEDED — this annotation is about the 62% figure] The review returned reject with six major findings…` exits 0; the same sentence without the bracket exits 1. Declared honestly in the header (`:52`), and it is the reduced form of pass 20's finding 5 rather than a recurrence of it.

**8. SEVERITY: minor — "the annotations ARE the registry" over-states the derivation.** Only the quoted `[SUPERSEDED — "…"]` form is parsed: **5 of the 28** `[SUPERSEDED` annotations in the six source files, and **0 of the 7** on `eli16.md`, the page where *"Mark a wrong phrase once and every page is protected from it afterwards"* (`:1356`) is printed. Downgraded from major because the explainer *does* state the quoting requirement two paragraphs later, and the guard header states the tracked-surface scope honestly. No live instance found: the unquoted annotations at `:1798`, `:1828`, `:2007` retire real claims, and I found no unannotated repetition of any of them.

**9. SEVERITY: nit — the guard's own documentation placeholder is parsed as real data.** `[SUPERSEDED — "<wording>"]` at `:28` enrols the wording `<wording>`; only `MIN_MATCHER_CHARS = 14` keeps it out. Verified: lengthening the placeholder to `<the retired wording goes here>` raises `matchersDerived` 3 to 4. This is the same "a negative control contains the thing it provokes" hazard the author fixed for the test file, unfixed in the file that does the fixing.

**10. SEVERITY: nit — the figure derivation is offset-bounded and proximity-free.** `header = readFileSync(auth).slice(0, 4000)`. Verified: a triple added inside the retired-figures sentence enrols (`figuresDerived` 6 to 9); the same triple placed past byte 4000 of the same header does not (`figuresDerived` stays 6). It also enrols *any* `N/N/N%` in that window, so a live figure ever written in that form would be watched as superseded.

**11. SEVERITY: nit — the lint file defines the claim registry but is exempt from it.** `lint-account-matches-tree.mjs` is an `ANNOTATION_SOURCES` member but not a `CLAIM_SURFACES` member; its header at `:13-14` contains the retired wording `used four times` twice, unannotated.

**No critical findings.**

## REGRESSION-CHECK

| Claim | Verdict | Evidence |
|---|---|---|
| **(a)** both populations deleted and derived | **PARTIAL** | Figures: all **six** derived, confirmed by `--json` (`figuresDerived: 6`) and by input — adding `333/222/11%` to the authority enrols it and refuses a reader-facing `333` with no second edit. Fail-closed on an empty authority present and tested. Claims: derived from `[SUPERSEDED — "…"]` annotations (5 wordings to 3 matchers, 2 skipped, both counts printed); an annotated wording *does* become a matcher and fires on another surface (verified: the annotation written into the log fires on `eli16` **and** on the behavioural test at `:418`/`:421`, proving the test file is genuinely watched). Members still missed: finding 3, finding 8, finding 10. |
| **(b)** tail heuristic + sliding window deleted | **NEW-DEFECT** | Double-report gone — the wrapped-claim test yields exactly one hit naming `eli16.md:2`. Sandwich case now refuses (verified by input and by restoring neighbour amnesty, which reds exactly that test). But the offset-map rewrite introduced finding 1: indented continuations are invisible, a case the deleted window caught. |
| **(c)** ARM 3, a citation is the obligation | **PARTIAL** | Fires by input, not by editing the guard: removing `pass20-verdict.md` gives `pass20-verdict.md is MISSING, and the tree cites review pass 20`; appending `As review pass 21 found…` gives `pass21-verdict.md is MISSING`; contiguity fires on a `pass1`/`pass3` archive. The tree's citing surfaces reference passes 1–20 and all 20 are archived, so the arm has real teeth today. Probes for citing-without-arming succeed (finding 2), and false positives exist (finding 5). |
| **(d)** watched/source distinction | **CLEAN** | No arm silently blinded. The behavioural test is in `CLAIM_SURFACES` and demonstrably fires (`:418`, `:421`) when a real matcher exists; it is out of `ANNOTATION_SOURCES` and `CITING_SURFACES`, and its fabricated citations correctly arm nothing. It was never in `READER_FACING`, so no figure coverage was lost. |
| **(e)** suite 32 to 37, seven sabotages | **CLEAN** | 37/37 green. All seven reproduced independently in a `git archive` clone, each restored byte-identical afterwards: arm-3 cited-missing to 1; contiguity to 1; claim scan to 3; neighbour amnesty to 1; missing-guard arm to 1; empty-authority guard to 1; figure **derivation parse** to **5**, exactly the clean-case controls plus the derivation test, as recorded. (Neutering `deriveFigures` by early-return instead reds 2 — a different mutation, not a contradiction.) The corrected wording "each isolating exactly the test(s) it should" is now accurate. |
| **(f)** pass 20 findings 3, 7, 8, 9, 10, 11 | **CLEAN** | 3: `eli16:1281` now reads "the nineteenth reading caught it". 7: `:1961-1962` reads `**this log had already used twice**` — balanced, unspliced. 8: `:134` names the 102-vs-104 disagreement verbatim and declines to smooth it. 9: corrected. 10: the missing-guard test exists and my sabotage reds exactly it. 11: the escape is real and the MEASURED clause now says "where the line it sits on carries `[SUPERSEDED`". |
| **(g)** `pass20-verdict.md` archived alone, before the repairs | **CLEAN** | By ancestry, not prose: `834ecb0b2` to `a5fa027ac` to `9020a4500`. `a5fa027ac` contains **exactly one file**, `pass20-verdict.md` (146 insertions), timestamped 04:11:55, 16 minutes before the repair at 04:28:02. The verdict it archives is run against `834ecb0b2`, the commit that precedes it. |
| **(h)** "fourteen" was false, not unverifiable | **CLEAN — the author is right and pass 20 is wrong** | I extracted `834ecb0b2`'s lint verbatim, widened `READER_FACING` to `CLAIM_SURFACES`, and ran it against the engineering log at four states: `930d8d13d`, `00ce6f926`, `834ecb0b2`, HEAD. **Log hits = 11 at every one**; test file = 2; total 13 everywhere. The count is invariant across the whole window pass 20 said made it unverifiable. "Fourteen" is reproducibly false, and 13 was never 14 either. |

**Passes 9–20 repairs still hold.** Full 47-step lint chain green end-to-end (`npm run lint`, exit 0, including `tsc --noEmit`). Four registry guards clean with the same numbers pass 20 recorded: fingerprint 88/6/82; gap records 7/7 against 6 fingerprinted; deferral 217/16/201; countdown 3 article + 47 sub-obligation, soonest 2026-09-07. `lint-registry-self-counts` clean. Archive complete and contiguous, `pass1`–`pass20`, every file a fenced verbatim reviewer block ending in **reject**. The two declared known-open reds reproduce exactly and only.

## MECHANISM-CHECK

- **(a) figure derivation — CLOSED** for the class its *own* prose names, proven by enrolment-by-input. **OPEN** for the class the two general-rule artifacts name (finding 3), with one live instance.
- **(a) claim derivation — PARTIAL.** Population is genuinely discovered from the material and immunisation-by-annotation works. Open: only the quoted form is parsed (finding 8), and there is no fail-closed over an empty population (finding 4).
- **(b) matching rewrite — PARTIAL.** Findings 4 and 5 of pass 20 are closed and tested. A new blind spot replaced them (finding 1), and it is a regression.
- **(c) ARM 3 — PARTIAL.** The limb is genuinely mechanical for the first time in eleven attempts, and it fires by input. Its population is narrower than three artifacts state and broader than English tolerates (findings 2, 5).
- **(d) watched/source — CLOSED.**
- **(e) sabotage suite — CLOSED**, with the untouched-tree control weaker than declared (finding 6).
- **(f) pass 20's nits — CLOSED.**
- **(g) archive-before-repair — CLOSED for this cycle**, and now backed by (c) rather than by resolution.

## MY-ACCOUNT-CHECK

**Re-derived by execution, not read:** the branch delta and per-commit file sets; `a5fa027ac`'s single-file content and ancestry; the archive's 20 files, each fenced and each ending `reject`; the figure derivation (all six, plus enrolment-by-input and the 4000-byte boundary); the claim derivation (5 wordings, 3 matchers, 2 skipped — and the identity of each); ARM 3's cited set (1–20) and every arming/evasion/false-positive probe; the indented-wrap regression, including running `834ecb0b2`'s lint on the identical input and running a corrected-scan variant over the pristine tree; the empty-claim-registry sabotage; the same-line amnesty; the phantom-matcher enrolment; all seven claimed sabotages, plus an eighth variant; the fixture's actual contents via replication; the full 47-step lint chain; all four registry guards' live counts; the two known-open reds; the annotation-form census (28 total / 5 quoted / 0 quoted on `eli16`); the ordinal-vs-numeric citation census in `eli16`; and the entire (h) reproduction across four commits.

**Carried without re-deriving:** the per-pass load-bearing figures for passes 1–14; the characterisation of findings inside passes 1–19 beyond the passages I quote; the known-open list as supplied, of which I verified three members.

**Discrepancies between the tree and its own records:**

1. **`pass20-verdict.md` says "all 46 steps" of the lint chain.** The chain has **47** steps at `834ecb0b2` and at HEAD. A reviewer's arithmetic error, now in the archive; it misleads no machinery.
2. **`pass20-verdict.md` records the "fourteen lines" figure as "unverifiable rather than false".** It is false and it is reproducible — 11 at every candidate state of the log across the whole window pass 20 said made it unverifiable. The author's self-caught correction to "eleven" is right, in both places.
3. `eli16.md:1367` and `:844` are each false about the file they are printed in (findings 2, 3).
4. `lint-account-matches-tree.mjs:36-38` and `…md:2177` describe a wrap capability the code does not have (finding 1).
5. **Not a branch defect:** `tests/unit/standards-registry-asset.test.ts` is 5 failed / 24 passed locally. `dist/` is gitignored, timestamped 2026-08-09 23:16, and its packed constitution hashes identical to the registry ten commits back on this branch. Stale local artifact; CI builds fresh. I attribute it, I do not count it.

## MAGNITUDE-METRIC

**Load-bearing: 3** — findings 1, 2 and 3.

- Findings 1 and 2 are **NEW**, introduced by the repairs made since pass 20. Each satisfies both limbs: an arm that cannot refuse an input inside the class its prose names, *and* committed artifacts (one reader-facing) asserting the property holds.
- Finding 3 is **CARRIED** — pass 20's finding 1, third element, untouched by the repair, now with a live counter-instance I located myself.

Under the prompt's broader wording finding 5 would also count and this pass would be **4**. Under pass 20's own treatment of its finding 5 — a reachable matching blind spot with no live instance graded *minor* — finding 1 would drop and this pass would be **2**. I record 3 and name both boundaries rather than pick the flattering one.

**Bookkeeping/process findings: 5** — findings 6, 7, 8, 9, 10, 11, plus the two archived-verdict errors in MY-ACCOUNT-CHECK, which belong to pass 20's record rather than to this branch.

## TRAJECTORY

Load-bearing, passes 1 to 21: **4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2 3 2 3** — every entry auditable against a committed verdict, and mine reproducible from the probes above.

What it shows, honestly on both sides:

**The decline is real and is not an artifact of grading.** The last five readings are 6, 2, 3, 2, 3 against a seventeen-pass plateau of 4–6. For the **second consecutive pass I could not find a defect in the four registry guards**; all seven claimed sabotages reproduce exactly, including the one whose count the author corrected himself; the 47-step chain is green; the archive is complete and contiguous for the second consecutive pass; every published count about the *code* reproduced to the digit; and — new — the one arithmetic error I found in this cycle was corrected by the author **before** the reviewer reported it, and my reproduction shows the reviewer's hedge was the wrong call, not the author's number.

**The generator is unbroken at fifteen consecutive passes, and its shape has moved one notch — for the worse.** Fourteen passes found "the instance gets fixed, the class gets announced as closed." Finding 1 is a new sub-shape: **a working capability was deleted while a stronger one was announced.** The two-line window caught indented wraps; the offset-map rewrite that replaced it, in the commit whose log says a wrapped claim is now "found exactly once, at its start", does not. And finding 2 is the purest specimen the series has produced: the mechanism built to end "a closure claimed and not delivered" ships with its own closure claim — *"It is now impossible… No promise left in it"* — stated on the reader-facing page in a citation form the mechanism cannot parse, about the limb that lapsed ten times, two paragraphs below a section heading written in exactly that unparseable form.

The findings are materially thinner than pass 11's or pass 14's — one has no live instance, one has a working alternative path, one is a carry-over. That thinness is genuine progress. It is not yet a different failure mode.

## CONVERGENCE

**Not met.** Clause by clause, exactly as written:

- *Not zero findings; known-open dated items not required closed; nits and harmless bookkeeping not held against it* — I hold none of them against this verdict. All the dated items are legitimately deferred. I discount findings 5–11 entirely from the metric, and I do not count the two archived-verdict errors against the branch.
- *Magnitude genuinely declining* — **SATISFIED. I credit it plainly, for the third consecutive pass and on the strongest evidence yet.** 6, 2, 3, 2, 3; the guard half clean under seven of the author's sabotages and eight of mine; the derivation demonstrably self-extending by input; the archive complete twice running; and for the first time in the series the author's own error-correction outran the reviewer's, with the reviewer's hedge proven wrong rather than the author's number.
- *Remainder converted to expiry-dated named work* — **fails, and in the same specific way it has failed since pass 17.** Findings 1 and 2 are not remainder to schedule. They are, again, a closure claimed and not delivered, and again the claim is about the mechanism built to end that class.

The blocking condition holds on its own terms: the repairs made since pass 20 introduced **two new load-bearing defects**. Fifteenth consecutive pass.

## COHERENCE

**No — and the divergence has narrowed again, to one axis, but it has not changed character.**

The machinery is in the best state of the twenty-one readings. Every arm I attacked refused exactly its own input. Seven author-declared sabotages and eight of mine each reddened precisely the tests named, restored byte-identical afterwards. The populations are genuinely derived: adding a triple to the authority enrols it with no second edit, and annotating a wording once makes it a matcher on every watched surface — I verified both by input, not by reading. The four registry guards are untouched and clean. The full 47-step chain is green. The archive is complete, contiguous, and now enforced by a limb that fires rather than by a promise.

The account still diverges from the tree, in named places, all on the reader-facing side: an explainer that tells the reader an obligation fires "anywhere" I write "the twentieth reading found…", when neither "anywhere" nor that phrasing arms it, printed two paragraphs under a heading in that exact unarmed form; the same explainer telling the reader no retired figure may sit unmarked on a page a person reads, printing 92% and 93% unmarked 465 lines above; an engineering log stating a wrapped claim is found "across any number of lines" when an indented continuation is invisible and used not to be; and a header stating "the annotations ARE the registry" when five of twenty-eight annotations are parsed and none of the seven on that reader-facing page.

The sharpest single artifact is `eli16.md:1367` — *"No promise left in it."* — three lines of a mechanism away from being true, in the paragraph about the promise that has been broken ten times.

## VERDICT

**reject.** This is the strongest state the branch has been in and that belongs before the refusal: the four registry guards are clean for the second consecutive pass under fifteen independent sabotages; both derived populations self-extend by input, which I proved by feeding them rather than by editing them; the archive is complete, contiguous, filed alone and sixteen minutes before the repair it prompted, and now defended by a limb that actually fires; all seven claimed sabotages reproduce, including the one whose count the author revised himself; the full 47-step lint chain and the 37-test suite are green; the only other red is a gitignored `dist/` ten commits stale, which I traced to the commit that built it; and on the one contested number this cycle the author is right and pass 20's verdict is wrong, which I verified across four commits. Magnitude is genuinely declining and I credit that clause without qualification. It fails the other clause, and it fails it as the last four passes did: the repair that deleted the sliding window also deleted a case that window caught, while its log announces the opposite; and the arm built to make the ten-times-lapsed archive promise mechanical is announced to the reader as "impossible to break" using a citation form it cannot parse — the form that document has used for every one of its twenty-one reading sections, including the heading two paragraphs above the sentence. Pass 20's prescription was carried out at the arm and left undone at the two artifacts it also named, so a retired figure still sits unannotated on the page that promises it cannot. The next move is small and it is not another population: make the citation trigger match the idiom the documents actually use (or make the documents use the trigger), restore whitespace-insensitive joining in the scan, give the claim derivation the fail-closed refusal its sibling already has, and correct the two general-rule sentences to the rule the guard implements — then the remainder really is dated, named work.
```
