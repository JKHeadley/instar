# External review pass 20 — reviewer's verbatim final answer

**Filed ALONE and BEFORE the repairs, unprompted.** Pass 20's mechanism-check makes this limb the point:
*"`grep -rl window10-external-passes scripts/ tests/ .github/ .husky/` returns nothing — no lint, test, hook
or CI step asserts the latest verdict is on disk before a repair commit. That limb has now lapsed ten times,
the tenth inside the commit that made the other two mechanical. It is the single cheapest closure still
available."* Filing it first, then making it mechanical in the repair that follows.

Pass 20 recorded load-bearing **2** — the series' joint-lowest — credited the magnitude clause as satisfied
*"on stronger evidence than pass 19 had"*, and reported **archive completeness is not a finding this pass —
the first time in five**. It also found that **for the first time in twenty readings no trajectory entry is
unverifiable**: both formerly self-reported entries (pass 17's 6, pass 18's 2) are now on disk and both
reproduce. Run against `834ecb0b2`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 20 — `echo/window10-deep-property-guards` @ `834ecb0b2`

## FINDINGS

**1. SEVERITY: major — the superseded-figure arm's population omits two of the six numerals its own cited authority forbids, and one of them is live and unannotated, twice, on the reader-facing explainer the arm exists to protect.**

`scripts/lint-deferral-referent-resolves.mjs:21-25` names **two** retired triples and says of both, verbatim, *"Do not quote either."* — `178/110/62%` and `194/104/54%`. `scripts/lint-account-matches-tree.mjs:73-77` introduces its list as *"Figures the deferral guard's own header says, verbatim, 'Do not quote either.'"* and then encodes four of the six: `['178','110','62%','54%']`. `194` and `104` are absent.

`194` is live and unannotated on a `READER_FACING` surface, twice:
- `docs/specs/window10-deep-property-guards.eli16.md:132` — *"Of 194 labels actually in use, 102 were invisible to it."*
- `:286` — *"It got **217** where I got 194"*

Proven: adding `'194','104'` to `SUPERSEDED_FIGURES` makes the lint exit 1 naming exactly those two lines. At HEAD it prints `clean — 2 reader-facing surface(s) free of 4 superseded figure(s)`. Line 132 sits **one line above** line 133, which the repair *did* annotate for `62%`/`54%` — the same paragraph, the same sentence's figures, half annotated.

Three artifacts assert the general rule the arm does not implement: `upgrades/side-effects/…md:2067` ("no superseded figure on a reader-facing surface without an explicit `[SUPERSEDED …]` annotation"), commit `930d8d13d`'s body (same wording), and — reader-facing — `eli16.md:1307` ("no retired figure may sit on a page a person reads unless it is explicitly marked as retired"), which is false about the file it is printed in. This is pass 19's finding 2 recurring one layer up: the mechanism built to close the class ships blind to members of it.

**2. SEVERITY: major — the retired-claim arm does not fire on a live, unannotated instance of one of its own five listed claims, inside its own listed surface; the third self-count correction is applied in the engineering log and not in the reader-facing explainer.**

`RETIRED_CLAIMS` includes `'already used four times'`; `CLAIM_SURFACES` includes `docs/specs/window10-deep-property-guards.eli16.md`. That file, at `:1250-1251`, still reads: *"The log already had a marker convention for retiring a wrong line, **used four times**. I appended instead of using it."* The corrected value is **twice** — recorded at `upgrades/side-effects/…md:2031` as `[SUPERSEDED — "the convention this log already used four times"] → **twice**`.

The arm misses it because the matcher is a literal substring of one phrasing and the live site interposes eight words between "already" and "used four times". Proven: adding `'used four times'` to the list makes the lint exit 1 on `:1250` and `:1251`. At HEAD it prints `clean — 4 tracked surface(s) free of 5 retired claim(s)`.

The consequence is the class pass 19 rejected on: pass 18's finding 4 correction was applied at one of its two sites, so a reader of the lay explainer is told the convention had been used four times while the log says twice — and the guard built in this same window to prevent exactly that divergence passes. The declared remainder ("a retired claim nobody adds to the list is uncovered") does not cover this: the claim **is** on the list and the surface **is** in the population.

**3. SEVERITY: minor — the lay explainer credits a finding to a review that had not happened, and contradicts itself fourteen lines later.**

`eli16.md:1279` (introduced by `930d8d13d`): *"That was wrong, and **the twentieth reading** caught it."* The document's own convention is unambiguous — `:1203` "The seventeenth reading…", `:1262` "Eighteenth reading.", `:1293` "**The nineteenth reading** is the first to say plainly…". Pass 19's finding 1 is what caught it, and `:1293-1297` attributes the *same* finding to the nineteenth reading. Two statements in one file, fourteen lines apart, assign one finding to different reviews; the twentieth reading is this one.

**4. SEVERITY: minor — the claim arm's refusal double-reports, and one copy names a line that does not contain the claim and quotes text that does not contain it.**

Because the two-line window is evaluated at every index, any violation confined to a single line is reported at window `i-1` *and* window `i`. Reproduced: a claim placed on line 2140 produced `…md:2139 repeats the RETIRED claim "six major findings" … — \`filler line one\`` alongside the correct `:2140` row. For a guard whose instruction is *"Correct it AT the claim"*, pointing at a line that does not contain it is a message defect of the class pass 15 finding 5 named. The behavioural test never exercises it (its fixture is a one-line file, so there is no preceding line).

**5. SEVERITY: minor — a retired claim sandwiched between two annotated lines is invisible to the claim arm.**

The escape is `line || next` contains `[SUPERSEDED`, so one annotation grants amnesty to its neighbours. Constructed and run: appending `[SUPERSEDED — an annotation]` / `The review returned reject with six major findings and no criticals.` / `[SUPERSEDED — another annotation]` to the engineering log exits **0**; the same claim between two filler lines exits 1. The announcement paragraph the repair created is a run of consecutive single-line annotated bullets — precisely the shape that produces contiguous amnesty.

**6. SEVERITY: minor — ARM 1's stated reach exceeds what it checks; a same-value duplicate under a non-horizon-named constant passes clean.**

The MEASURED clause says each guard *"declares no numeric horizon literal of its own"* and the clean line says the guards *"share one horizon definition"*. `HORIZON_LITERAL_RE` only matches a `const|let|var` whose **name contains "horizon"**. Replacing `const HORIZON_DAYS = COUNTDOWN_HORIZON_DAYS;` with `const GAP_DEADLINE_DAYS = 180; const HORIZON_DAYS = GAP_DEADLINE_DAYS;` leaves the lint printing `clean — 2 countdown guard(s) share one horizon definition`, which is then false. (The suite does red, but only incidentally — one test's string-replace target vanished.) Pass 19's prescription was implemented as literally written; the residual is that the sentence describing it is broader than the regex.

**7. SEVERITY: nit — pass 19's nit 6 is half-repaired: the emphasis markers are now genuinely unbalanced, and the annotation still interrupts the sentence.** `upgrades/side-effects/…md:1961-1966` contains three `**` runs (`**this log already` + `**twice**`), so the leading `**` is unmatched and renders literally; the pre-repair text had four and rendered without a stray. Nit 6 named both the numeral placement (fixed) and the unbalanced markers (not fixed). The annotation still sits between "twice" and ", which is the point", so the phrase is still spliced — and the line beginning `, which is the point:` renders with a leading space before the comma.

**8. SEVERITY: nit — the account disagrees with itself about a retired figure.** `lint-deferral-referent-resolves.mjs:22` gives the second retired triple as `194/104/54%`; `upgrades/side-effects/…` gives *"102 of 194 marker ids (53%) … the guard saw 47% of its subject"* and `eli16.md:132` gives *"Of 194 labels … 102 were invisible"*. 102+92=194 and 104+90=194; the two records differ by 2 on the same measurement.

**9. SEVERITY: nit — "each isolating exactly its own test" is contradicted by its own next clause.** `upgrades/side-effects/…md:2121` and commit `834ecb0b2` both claim the three new sabotages each isolate exactly their own test, then immediately state *"neuter the claim loop → both claim tests red"*. I reproduced all three; the first reds two, as its own detail says.

**10. SEVERITY: nit — ARM 1's missing-guard-file refusal is covered by no test.** Neutering `failures.push(\`${rel} is missing …\`)` leaves the suite 32/32 green. It is the fail-closed direction and inside the declared "~40% refusal-arm coverage" residual, but it is the one arm of the new lint that no sabotage reaches.

**11. SEVERITY: nit — two cosmetic inaccuracies inside the new lint.** `fig.replace('%', '%')` is a no-op that reads as escaping; and the MEASURED clause says no figure appears *"except within a two-line window carrying an explicit `[SUPERSEDED` annotation"* — the figure arm's escape is per-line, not a window (stricter than described, but described wrongly).

**No critical findings.**

## REGRESSION-CHECK

| Repair | Verdict | Evidence |
|---|---|---|
| **(a)** `lint-account-matches-tree.mjs` | **ARM 1 CLEAN · ARM 2 NEW-DEFECT** | Arm 1 verified by reproduction, not by reading: I restored pass 18's exact shape at HEAD (`const HORIZON_DAYS = 180`, zero refs to `COUNTDOWN_HORIZON_DAYS`) — the lint exits 1 with **both** arm-1 messages, while all 23 pre-existing behavioural tests stay green (4 failed / 28 passed, every failure inside the new describe block). The claim that the same-value duplicate is behaviourally invisible and statically catchable is **true and now demonstrated**. Arm 2b: finding 1. Arm 2a: findings 2, 5. Arm 1 residual: finding 6. |
| **(b)** suite 23 → 32 | **CLEAN** | 32/32 green. All three claimed sabotages reproduce exactly: neuter the claim loop → 2 failed (both claim tests); collapse the window to one line → 1 failed (split-across-lines only); widen the figure arm to `CLAIM_SURFACES` → 1 failed (narrowing control only). Six further sabotages of my own each isolated exactly one test: arm-1 literal, arm-1 symbol, arm-2b figure loop, arm-2b escape, arm-2a escape. Both false-positive controls genuinely discriminate. Only uncovered arm: finding 10. |
| **(c)** self-counts applied at the claim sites | **CLEAN** | I re-derived `pass1-verdict.md` myself: eight `SEVERITY:` lines — `critical` (empty class), five `major`, one `minor`, `nit` (empty class) ⇒ **0 critical / 5 major / 1 minor / 0 nit**. The naive-grep caveat is exactly right. `:388` now reads "**five major and one minor** finding"; the over-attribution reads "**One** of the eleven…" at all three sites (`…md:1913`, test header `:15`, `eli16.md:1211`), each citing pass15-verdict.md finding 5, whose text I confirmed ends as quoted. |
| **(d)** nit 6 unspliced | **PARTIAL** | The wrong numeral is gone and the annotation now follows the figure; the announcement paragraph is genuinely restructured to one annotation per retired claim, each mark on its claim's line. But the splice remains a splice and the emphasis is now unbalanced — finding 7. |
| **(e)** `pass19-verdict.md` archived | **PARTIAL — and honestly recorded** | Ancestry, not prose: `930d8d13d` → `00ce6f926` → `834ecb0b2`. `00ce6f926` contains exactly one file (114 insertions, the verdict). It follows `930d8d13d`, which is a post-pass-19 repair commit whose body says *"THE ARCHIVE CONVENTION, FINALLY IN THE RIGHT ORDER"* while omitting pass 19's verdict. So the verdict precedes the repair commit that followed **it**, and the tenth lapse is real and accurately labelled. |
| **(f)** two false starts | **CLEAN** | Neither resolution disabled an arm. `READER_FACING` is byte-identical between `930d8d13d` and HEAD, so the narrowing restored the original population rather than shrinking it; and stripping the `[SUPERSEDED — fixture]` comments from the test file makes the claim arm fire on `tests/unit/window10-guards-behaviour.test.ts` — the file is genuinely in scope, not silently excluded. The "fourteen lines" figure is **not reproducible** at HEAD (widening the figure arm now yields 13: 11 in the log, 2 in the test file), but the log gained 78 lines including annotations between the false start and the commit, so I record it as unverifiable rather than false. |

**Passes 9–19 repairs still hold.** All four registry guards clean on the real tree: fingerprint 88 articles / 6 fingerprinted / 82 grandfathered; gap records 7 gaps / 7 swept against 6 fingerprinted standards; deferral 217 / 16 resolve / 201 orphaned (baseline 201, shrink-only); countdown 3 article + 47 sub-obligation, soonest 2026-09-07. Nine independent arm sabotages each isolated exactly their own test. Full lint chain green — `tsc --noEmit` plus all 46 steps (verified end-to-end in a `git archive` copy, which reached step 42 and failed only on the copy's absent `.git`; the last five steps re-run individually in the real tree all pass). The only reds are the two declared known-opens: `standards-coverage --check`, and `standards-coverage-ratchet` at 1 failed / 34 passed — the failure being exactly *"the live registry closes all six family audits"*. No prior repair was weakened; neither of the last two commits touched a guard or the registry.

## MECHANISM-CHECK

- **(a) ARM 1 — CLOSED for the shape it was prescribed against** (horizon-named literal, missing import), proven by reproducing pass 18's defect. **PARTIAL** for the property the prose states (finding 6).
- **(a) ARM 2b — OPEN.** The rule stated in three artifacts is not the rule implemented; two of six forbidden numerals are outside the population and one is live (finding 1).
- **(a) ARM 2a — OPEN.** Exact-substring matching over a five-element list misses a listed claim in a listed surface (finding 2), and the window escape has a reachable blind spot (finding 5).
- **(b) CLOSED**, with one uncovered arm (finding 10).
- **(c) CLOSED.**
- **(d) PARTIAL.**
- **(e) OPEN as a mechanism.** Pass 19 prescribed three limbs; two were made mechanical and the third was left to willpower. `grep -rl window10-external-passes scripts/ tests/ .github/ .husky/` returns **nothing** — no lint, test, hook or CI step asserts the latest verdict is on disk before a repair commit. That limb has now lapsed ten times, the tenth inside the commit that made the other two mechanical. It is the single cheapest closure still available and the only one of the three the repair skipped.

## MY-ACCOUNT-CHECK

**Re-derived by execution, not read:** the archive's completeness and authenticity (19 files, `pass1`–`pass19`, every one a fenced verbatim reviewer block with reviewer-specific formatting — including `pass18-verdict.md`, which pass 19 could not check and which does self-report load-bearing 2); pass 1's severity tally directly from the file; the commit ancestry and per-commit file sets; all nine arm sabotages plus the three claimed ones; the pass-18 drift reproduction and its 23-green result; the "arm 2 found five where the reviewer named one" claim (exactly 5, at `eli16` 26/133/134/515/933, run against the pre-repair tree with the `930d8d13d` lint); both false-start resolutions; the 194 and "used four times" gaps; the sandwich escape; the non-horizon-named residual; the double-report defect; every guard's live counts; the lint chain; the two known-open reds; the `eli16` reading-numbering convention.

**Carried without re-deriving:** the per-pass load-bearing figures for passes 1–14 (I read the magnitude sections of 15–19 directly and recounted nothing earlier); the characterisation of findings inside passes 1–17 beyond the sections I quote; the known-open list as supplied, of which I verified two members.

**Discrepancies I found:**

1. **The prompt's trajectory is stale.** It marks position 17 as `[6 unverifiable]`. That is *pass 18's* labelling, written when `pass17-verdict.md` was absent; pass 19 moved the asterisk to position 18 (`2*`), written when `pass18-verdict.md` was absent. **Both files are now in the archive and both self-report the figures the series carries** (`pass17`: "This pass: 6"; `pass18`: "I count 2"). For the first time in the series **no entry is unverifiable.** That is a real improvement the prompt's framing hides.
2. **The metric is not constant across 18 → 19.** Pass 18 reached 2 by *excluding* a falsely-closed documentation defect ("serious, but not machinery"); pass 19 reached 3 by *including* account defects. Part of that step is definitional, not empirical.
3. `eli16.md:1279` and `:1293` credit the same finding to different readings (finding 3).
4. The guard header and the two logs disagree by 2 on a retired figure (finding 8).
5. The tree's account of the new guard's reach exceeds the guard in two places (findings 1, 2, 6).

**Archive completeness is not a finding this pass** — the first time in five.

## MAGNITUDE-METRIC

I keep pass 19's definition for comparability: *a finding that either leaves a guard unable to refuse an input it claims to refuse, or leaves a committed artifact asserting something false about the machinery.*

**Load-bearing: 2** — findings 1 and 2. Each satisfies both limbs: an arm that provably does not fire on an input inside its own declared population, *and* committed artifacts (one reader-facing) asserting the rule holds.

Finding 3 asserts something false about the **review record**, not the machinery, so I exclude it, consistent with pass 18's treatment of the identical class; under the broadest reading (all account-defects count, which is pass 19's *practice* if not its stated definition) this pass is **3**. Findings 4–6 are residual mechanism narrowings; 7–11 are bookkeeping and cosmetic. **Bookkeeping/process findings: 6** (3, 7, 8, 9, and the two limbs of 11).

## TRAJECTORY

Load-bearing, passes 1→20: **4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2 3 2** — and, for the first time, **every entry is auditable against a committed verdict.**

What it shows: the decline is real and it is now *verifiable* rather than partly self-reported. The last four readings are 6 → 2 → 3 → 2 against a seventeen-pass plateau of 4–6. More decisive than the count is where the defects now live. **I could not find a single defect in the four registry guards.** Nine independent sabotages each reddened exactly one named test; the horizon reproduction that pass 18 used to expose a false sweep now exposes nothing; every published count about the code reproduced to the digit. Both of my load-bearing findings are inside machinery that did not exist two commits ago, and both miss only documentation-level instances.

But the *generator* is unbroken at 14 consecutive passes, and its shape has not moved at all: **the instance gets fixed, the class gets announced as closed.** Pass 19 named that shape and prescribed three mechanical closures. Two were built — and both shipped with a population narrower than the class they name, letting through live instances of the very defect, while three artifacts state the general rule. The third was not built at all and lapsed for the tenth time in the commit that built the other two. The declining number reflects a shrinking mechanism surface; it does not yet reflect a repository that has stopped over-stating its own closures.

## CONVERGENCE

**Not met.** Clause by clause, exactly as written:

- *Not zero findings, known-open dated items not required closed* — I hold none of them against this verdict. The stale Building/The Substrate audits (and the two reds they produce), the establishing-path baselines, prose-in-JSON-string-value, the non-monotone `/*…*/` case, orphan-is-not-abandoned, registry-populations divergence, the countdown collection gate, the instrument's copied regexes, `baseline-history.mjs`'s absent tests, and the ~40% refusal-arm coverage are all dated, named and legitimately deferred. I discount findings 7–11 entirely, and I do not count finding 3 in the metric.
- *Magnitude genuinely declining* — **SATISFIED, and on stronger evidence than pass 19 had.** I say so plainly. 6 → 2 → 3 → 2, the mechanism half clean under nine sabotages and a full reproduction of the defect that motivated the whole repair, and — new this pass — the series is fully auditable for the first time in twenty readings, with both formerly-unverifiable entries now on disk and both reproducing.
- *Remainder converted to expiry-dated named work* — **fails, in the same specific way pass 19 named.** Findings 1 and 2 are not remainder to schedule. They are, again, a closure claimed and not delivered — and this time the claim is about the mechanism built to end that class. `934…`/`834ecb0b2` say the class is "now mechanical"; the mechanism reports `clean` over a forbidden figure printed twice on the reader-facing explainer and over a listed retired claim printed once on the same file, and the explainer itself tells the reader that neither can happen.

The blocking condition holds on its own terms: the repairs made since pass 19 introduced two new load-bearing defects — a guard whose declared population is narrower than the class its prose names, and the three artifacts asserting the wider rule. Fourteenth consecutive pass.

## COHERENCE

**No — but the divergence is now confined to one axis and it is narrow.**

The machinery is in the best state of the twenty readings. Every arm I attacked refused exactly its own input; the horizon is genuinely unified and I proved it by reproducing the defect that exposed its absence; the full lint chain and 32/32 behavioural suite are green; every count about the *code* — 32 tests, four guards, five lints in the chain, 88/6/82, 7/7, 217/16/201, 3+47 — reproduced exactly.

The account still diverges from the tree, in named places: a lay explainer that tells the reader no retired figure may sit on a page a person reads, printing one twice on that page; the same explainer telling the reader a convention was "used four times" when the log beside it records twice, with the guard for that exact claim reporting clean; a lint whose list is introduced as the deferral guard's forbidden set and contains four of its six members; a clean line asserting two guards "share one horizon definition" when what is checked is a textual mention plus one naming pattern; and a document crediting a finding to a review that had not happened, contradicting itself fourteen lines later. The sharpest single artifact is `eli16.md:1307` — *"no retired figure may sit on a page a person reads unless it is explicitly marked as retired"* — sitting 1,175 lines below `:132`, where one does.

## VERDICT

**reject.** This is the strongest state the branch has been in and I want that on the record before the refusal: the four registry guards are clean under nine independent sabotages, repair (a)'s arm 1 genuinely closes the case pass 18 found and I proved it by reproducing that case, the behavioural suite's three claimed sabotages each isolate exactly what the author says they isolate, the two false-start resolutions narrowed nothing that mattered, the pass-1 severity correction is right at the site where the claim lives and I re-derived it independently, the over-attribution is corrected in all three places, and the archive is complete for the first time in five passes — with both previously-unverifiable trajectory entries now on disk and both reproducing. Magnitude is genuinely declining and I credit that clause. It fails the other clause, and it fails it the same way pass 19 did: two committed guards that report `clean` over live instances of the exact class they were built to close, and three artifacts — one of them the explainer an outside reader meets — stating the rule they enforce. `194` is forbidden by the authority the lint cites and is printed twice, unannotated, on the surface the lint watches; `already used four times` is on the lint's own list, on the lint's own surface, and the lint cannot see it. The prescription was made mechanical and the mechanism was shipped with the same gap the prose had. The one limb of pass 19's prescription that was *not* made mechanical — archive before repair — lapsed for the tenth time inside the commit that mechanised the other two, and nothing in `scripts/`, `tests/`, `.github/` or `.husky/` references the archive directory at all. That is the cheapest remaining closure and the clearest next move: make the third limb mechanical, and derive the two populations from their sources instead of transcribing them, because a hand-transcribed population is this branch's own recorded blind spot and it has now produced the finding twice in one guard.
```
