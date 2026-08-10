# External review pass 19 — reviewer's verbatim final answer

**Filed after the repair commit — the TENTH lapse of this convention, and it happened inside the very
commit (`930d8d13d`) whose own message recorded the ninth as finally done in the right order.** Pass 19's
third finding was this exact class: a closure claimed and not delivered. Filed here rather than waiting for
pass 20 to find the file absent, which is what each of the last four lapses required.

Pass 19 recorded load-bearing **3**, and is the **first pass of the nineteen to credit the magnitude clause
of the acceptance criterion as SATISFIED**. Zero of its three load-bearing findings were guard defects; all
three were closures asserted and not made. Run against `083e10cf9`. Exploration logs are NOT kept; only the
final answer block.

---

```text
# EXTERNAL REVIEW PASS 19 — `echo/window10-deep-property-guards` @ `083e10cf9`

## FINDINGS

**1. SEVERITY: major — the new "same horizon" test does not detect the defect it was written to detect, and four committed artifacts (one reader-facing) state that it does.**

HEAD's 23-test suite, run against the *exact* pre-repair code pass 18 rejected (`HEAD~1`'s `lint-enforcement-gap-records.mjs`: private `const HORIZON_DAYS = 180`, zero references to `COUNTDOWN_HORIZON_DAYS`, shared bound also 180), passes **23/23 green**. Re-introducing the drift into HEAD is likewise green. The test compares each guard's *printed number* against the shared constant, so a duplicated literal that happens to equal the shared value is invisible; only a *divergent* literal (I verified with 200) reds it. Pass 18's defect was a duplicate at the *same* value — which this test cannot see.

Four false statements follow from it:
- `tests/unit/window10-guards-behaviour.test.ts:283` — "This is the test that would have caught pass 18's finding." It would not have.
- `upgrades/side-effects/…md:1999` — "**the suite would now catch the exact defect pass 18 found.**" It does not.
- The commit message — "I re-introduced pass 18's exact drift and it goes red."
- `docs/specs/window10-deep-property-guards.eli16.md:1277` — "I re-introduced the exact drift and it goes red." (reader-facing lay explainer)

The side-effects table row is internally self-refuting: it labels the sabotage "re-introduce pass 18's drift" while parenthesising "(gap guard keeps a private **200**)" — a different mutation from the one pass 18 found. No static guard covers this either: `lint-no-duplicate-definitions.mjs` is scoped to `docs/STANDARDS-REGISTRY.md` headings/IDs only, so nothing in the repository can fail if the private bound returns. This is precisely the registry's own `alive-but-inert` shape, in the test written to close it.

**2. SEVERITY: major — the pass-18 finding was recorded closed while still live on the same reader-facing surface.**

`docs/specs/window10-deep-property-guards.eli16.md:26` reads *"The **110** already there are recorded as a debt that can only shrink"*. `110` is the superseded deferral figure the guard's own header (`scripts/lint-deferral-referent-resolves.mjs:24-25`) says of, verbatim, *"Do not quote either."* It sits **eleven lines below that same file's own new disclaimer** that "the numerals are deliberately not repeated", and **thirteen lines below** its own corrected statement that the true count is **201**. It is unannotated, factually wrong, and introduced by this branch (absent on `origin/main`, present at `HEAD~1`, untouched by the repair). The commit records both surfaces corrected. This is a verbatim recurrence of pass 18's headline finding — *a finding falsely marked closed is worse than an open one* — inside the commit that says so.

**3. SEVERITY: major — two of the three claimed self-count corrections were announced and applied nowhere.**

- *"six major findings"*: `upgrades/side-effects/…md:388` still reads "**VERDICT: reject** with six major findings and no criticals. All six were acted on". I re-derived `pass1-verdict.md` myself: 0 critical, **5 major, 1 minor**, 0 nit. The line is byte-identical to `HEAD~1`; the only "six major" the diff touches is the *announcement* at `:2021`. The log's own announcement concedes it was "corrected twice before by passes 6 and 10 and never in this log" — and it is again never in this log.
- *over-attribution*: "two of the eleven streak defects were arms I made unreachable" survives in **three** places, all untouched — `upgrades/side-effects/…md:1913` (110 lines above its own announcement), `tests/unit/window10-guards-behaviour.test.ts:15`, and `docs/specs/…eli16.md:1211` (reader-facing paraphrase).

This reproduces, verbatim, the failure this same file diagnoses at `:1959-1961` for pass 17: *"Three corrections announced here and applied nowhere here — the announcements of three fixes appended eighty-four lines below the text they did not fix."*

**4. SEVERITY: major — `pass18-verdict.md` is absent from the entire repository history.** `git log --all --diff-filter=A` over the archive directory returns exactly seventeen blobs, `pass1`–`pass17`. Every claim in the tree about pass 18 — "load-bearing 2", "the lowest of eighteen", "the strongest pass of the eighteen", and the two false claims in finding 1 — rests on the author's prose with nothing to check it against. Ninth lapse, **fourth consecutive**, filed each time only after the next reviewer pointed at it.

**5. SEVERITY: minor — refusal-arm coverage is ~40% and nothing measures it.** 57 `failures.push` sites across the four guards; 23 test cases. The two uncovered article arms pass 18 found were found by a *reviewer*, not by any coverage instrument, so the same class recurs by construction.

**6. SEVERITY: nit — the one correction that *was* applied is spliced mid-phrase.** `upgrades/side-effects/…md:1962` renders as `…convention **this log already used **[SUPERSEDED — twice, not four times; …]** four times**…`. The wrong numeral remains *after* the annotation (house style elsewhere, `:19`/`:75`, places the bracket after the figure), and the bold markers are unbalanced. The count itself (twice) I independently re-derived as correct.

**No critical findings.**

## REGRESSION-CHECK

| Repair | Verdict | Evidence |
|---|---|---|
| **(a)** horizon sweep | **CLEAN** | `lint-enforcement-gap-records.mjs:133` imports both symbols; `:284-285` alias them. Pass 18's experiment reproduced in a temp copy: shared constant → 5 makes **both** guards refuse ("beyond the 5-day horizon", exits 1). Repo-wide sweep found no other private copy. |
| **(b)** behaviour tests | **NEW-DEFECT** | Finding 1. Two of three new tests are genuinely sabotage-proven (disabling the article-horizon arm reds exactly *refuses an ARTICLE countdown beyond the horizon*, 1 failed/22 passed; disabling the article-expiry arm reds exactly its own test, 1/22). The third does not detect its stated target: 23/23 green against the exact pre-repair code. |
| **(c)** superseded figure | **NEW-DEFECT** (false-closure) | `upgrades/next/…md` is genuinely clean (headline now 217/201; zero occurrences of the numerals in that directory) and the narrow claim "not reproduced in the explanatory notes" is TRUE. But `eli16.md:26` keeps `110` live, and the commit records the surface corrected. Finding 2. |
| **(d)** self-counts | **NEW-DEFECT** | 1 of 3 applied (with finding 6's splice); 2 of 3 announced-only. Finding 3. |
| **(e)** `pass17-verdict.md` | **CLEAN** | Present, substantive, verbatim reviewer block, correctly self-labelled as the eighth lapse. |

**Passes 9–18 repairs still hold.** All four guards pass on the real tree (fingerprint: 88 articles/6 fingerprinted; gap records: 7 gaps/7 swept; deferral: 217/16/201; countdown: 3 article + 47 sub). The pass 9–17 arms remain covered and discriminating: heading-collision both halves, 1–3-space indented headings with the fenced-example control, JSON-comment key, shell comment after punctuation, leg-4 reachability, horizon boundedness, partition-verdict, duplicated tracked id. The only executable change at HEAD strictly improves the gap guard; no prior repair was weakened. The one red unit assertion (`standards-coverage-ratchet` → stale Building/The Substrate area audits) and the red `standards-coverage --check` are exactly the declared, operator-ruled known-open items.

## MECHANISM-CHECK

- **(a) CLOSED.** One definition, both callers, proven by the experiment that exposed its absence.
- **(b) PARTIAL.** Article-horizon and article-expiry arms genuinely closed and isolated. The drift arm is **OPEN** — the property "one definition, both callers" remains unguarded by any test or lint. A real closure is static (assert the guard's source imports the symbol / contains no numeric horizon literal), not behavioural.
- **(c) PARTIAL.** `upgrades/next/` closed; `eli16.md` open at `:26`.
- **(d) PARTIAL.** One of three closed.
- **(e) CLOSED.**

## MY-ACCOUNT-CHECK

**Re-derived myself:** the pass-1 severity tally (5 major + 1 minor + two "no findings" placeholders) directly from `pass1-verdict.md`; the per-pass severity totals for passes 1–17 by machine count; the "convention used twice" figure; the 23-test count; the four-guard count; the seventeen archived verdicts; the live 217/16/201 deferral figures.

**Carried:** the load-bearing series 1→17 (`4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6`) as each reviewer self-reported it, and pass 18's self-reported load-bearing 2 — which is **uncheckable**, since no pass-18 verdict exists.

**Discrepancies:** (i) the "six major" claim at `:388` contradicts the archived verdict and is live for the third time; (ii) the over-attribution is live in three artifacts; (iii) the commit's and eli16's "it goes red" claims are false against execution; (iv) the side-effects table's own "(private 200)" contradicts the "exact defect" sentence beside it. The counts-about-the-*code* (23 tests, four guards, four `describe` blocks) all check out exactly. The pattern is sharp and worth naming: **every count about the code is right; the counts about the record keep being wrong.**

## MAGNITUDE-METRIC

I keep pass 17's definition for comparability: **a finding that either leaves a guard unable to refuse an input it claims to refuse, or leaves a committed artifact asserting something false about the machinery.** I add the series' own convention that account-defects count (pass 12 established this). Under it: findings 1, 2, 3 are load-bearing → **3**. Finding 4 (missing verdict) makes claims *unauditable* rather than *false*, so I exclude it, consistent with pass 9's treatment; including it gives 4. Findings 5–6 are residual and cosmetic.

## TRAJECTORY

Load-bearing, passes 1→19: **4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6 2\* 3** (\* = self-reported, unverifiable).

**Magnitude is genuinely declining — modestly, and the decline is real rather than an artifact.** The mechanism half of the work is in its best state of the nineteen: all four guards pass, every arm I probed discriminates correctly, the horizon is genuinely unified and I proved it by the experiment that exposed its absence, and for the first time a repair (a) survived my attack unchanged. The last three passes sit at 6 → 2\* → 3 against a plateau of 4–6.

But the *composition* has not moved at all. Of my three load-bearing findings, **zero** are guard defects and **three** are account defects — false or falsely-closed statements about what the machinery does. That is the same composition as pass 12, pass 14 and pass 17. The declining number reflects a shrinking mechanism surface, not a repository that has stopped mis-describing itself.

## CONVERGENCE

**Not met — but by a narrower margin than any prior pass, and for a different reason than the criterion's first clause.**

Taking the criterion exactly as written, clause by clause:

- *Not zero findings* — correctly not required, and I hold none of the known-open dated items against this verdict. The stale area audits, the establishing-path baselines, the `/*…*/` non-monotone case, orphan-is-not-abandoned, the registry-populations divergence, the countdown collection gate, the instrument's copied regexes, and `baseline-history.mjs`'s absent tests are all dated, named, and legitimately deferred. Finding 6 misleads no machinery and I discount it entirely.
- *Magnitude genuinely declining* — **I judge this clause SATISFIED.** I say so plainly because the evidence supports it and because a reviewer should not withhold a clause the data earns. 6 → 2 → 3 with a clean mechanism sweep is a real decline, and repair (a) is the first repair in this series to survive an adversarial reviewer's own reproduction intact.
- *Remainder converted to expiry-dated named work* — **this is where it fails.** Findings 1, 2 and 3 are not remainder to schedule; they are three artifacts asserting, right now, that work was done which was not. And they fail the criterion in the specific way that matters most: **all three are self-reports of closure that execution falsifies.** A branch whose entire subject is *machinery that verifies its own claims* cannot converge while its own closure claims are the thing that keeps failing.

The blocking condition also still holds on its own terms: **the pass-18 repair introduced a new load-bearing defect** (the non-detecting drift test, plus the false-closure of a finding on the surface it was closed for). That is the thirteenth consecutive pass at which the immediately preceding repair introduced a new one.

One structural observation I would put above any individual finding. The recurring shape is now unambiguous and has appeared four consecutive times: **the instance gets fixed, the pattern gets announced.** Pass 17's repair closed the horizon and skipped the sibling. Pass 18's repair swept the horizon (genuinely) and then wrote a test that cannot see the drift, corrected one surface of a two-surface finding, and applied one of three announced corrections. Finding defects faster will not end this, and neither will another prose commitment. The mechanical closure available here is small and concrete: a static lint asserting each countdown guard's source imports the shared symbol and contains no numeric horizon literal; a lint asserting the forbidden numerals appear on no reader-facing surface (`upgrades/next/`, `*.eli16.md`) except inside an explicit `[SUPERSEDED]` annotation; and archiving the verdict *before* the repair commit rather than after the next reviewer asks. All three are the repository's own proven patterns. Note that finding 2 is exactly the second of those, and the repository has now been told about it twice.

## COHERENCE

**No.**

The repository's machinery is in good order — the guards refuse what they claim to refuse, the horizon is genuinely unified, and every count the artifacts make *about the code* is exactly right. But its account of itself is not what its machinery does, in four independently verifiable places: a test file that tells the reader it would have caught pass 18's finding and does not; a lay explainer that says the numerals are deliberately not repeated and then repeats one, eleven lines later, contradicting its own corrected figure thirteen lines above; an engineering log that announces three corrections and applies one; and a review archive whose eighteenth verdict does not exist while eight statements in the tree cite it. The single most telling artifact on the branch is the side-effects table row that labels a 200-literal sabotage "re-introduce pass 18's drift" and then, in the next sentence, asserts the suite would catch the exact defect — the mislabel and the false claim it produces are visible in the same paragraph.

## VERDICT

**reject.** This is the strongest state the branch has been in: repair (a) is the first repair in nineteen passes to survive my own adversarial reproduction unchanged, all four guards refuse correctly on the real tree, the two new article-level tests are genuinely sabotage-isolated, `upgrades/next/` is clean, `pass17-verdict.md` is properly filed, and no pass 9–18 repair has regressed. I credit the magnitude clause of the criterion as satisfied and I have held none of the known-open dated items against this verdict. But the repairs made since pass 18 introduced three new load-bearing defects, and all three are the same defect wearing different clothes: **a closure claimed and not delivered.** The test written to make pass 18's drift detectable passes 23/23 against the exact code pass 18 rejected, while four artifacts — one of them the lay explainer an outside reader meets — state that it goes red. The forbidden figure the commit records as removed from both reader-facing surfaces is still on one of them, eleven lines under that file's own promise not to repeat it. Two of three announced bookkeeping corrections were applied nowhere, reproducing verbatim the failure the same file diagnoses for pass 17 eighty lines earlier. And the verdict that would let any later reader check any of this does not exist. On a change whose entire purpose is machinery that verifies its own claims, self-reported closure falsified by execution is the one residual class that cannot be scheduled as remainder — it must be fixed, and the fix must be structural, because four consecutive passes have now shown that announcing it is not the same as doing it.
```
