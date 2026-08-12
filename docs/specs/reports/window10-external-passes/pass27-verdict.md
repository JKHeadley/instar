# External review pass 27 — reviewer's verbatim final answer — **REJECT, load-bearing 7**

**The first prompt to ask BOTH questions — test the repairs AND judge the tree fresh — after pass 26 proved
the repair-chase framing was the defect.** The result vindicates the change and indicts the repair: 7
load-bearing findings, **2 repair-induced and 5 pre-existing**, and the four highest-value ones came from
places the repair-chase structurally cannot route to — production `src/` code, a JSON record's prose, a
parse-width property shared across the guard family, and a reviewer's citation of the tree.

**Its sharpest finding is against my own repair.** The pass-26 parser fix did not WIDEN the figure
population, it SHIFTED it: `%?` followed by `\b` backtracks in prose, so the two notations the authority
actually names went unwatched while two bare numerals started false-positiving.

**And it caught a number I put in its own prompt.** I derived refusal-arm coverage at 22 of 84 by mutation,
reported it, and never landed it in the repository — then carried it into review prompts as a known-open.
Pass 26 cited it as a tree declaration to withhold 17 surviving mutants. Pass 27 grepped for it: *"That
figure appears nowhere in the repository."* A measurement that lives only in a message is not a measurement
the work has.

Run against `6c21e825b`. Exploration logs are NOT kept; only the final answer block.

---

```text
# EXTERNAL REVIEW PASS 27 — `echo/window10-deep-property-guards` @ `6c21e825b`

## FINDINGS

**CRITICAL — class empty.**

**1. SEVERITY: major (load-bearing) — REPAIR-INDUCED. The pass-26 figure-parser fix did not widen ARM 2b's population; it SHIFTED it, and the two retired notations the authority actually names are now unwatched.**

The trailing `\b` cannot hold after a `%` unless the next character is a word character, so in ordinary prose the engine always backtracks and drops the percent sign. `%?` is dead in every realistic context.

Consequence: the derived set changed from `178,110,62%,194,104,54%` to `178,110,62,194,104,54`. ARM 2b's own match regex excludes `%` in its trailing class, so the bare figure cannot match the percent form either.

Proven by injection, both directions, with controls:

| input on a reader-facing surface | post-repair | pre-repair (control) |
|---|---|---|
| `An earlier measurement put it at 62% of markers.` | **clean** (missed) | refused, names "62%" |
| `The suite now carries 62 assertions in this area.` | **refused** (false positive) | clean |

Those are the exact third elements of the two triples the authority says "Do not quote either." The repair's stated goal does work — `figuresDerived` 6 → 9 when a percent-free triple is added. It bought that by trading the two named notations for two generic two-digit numerals. Collateral: the percent-escape at `:495` is now unreachable; two comments still describe the `N/N/N%` form as what the arm parses. A latent false-enrolment class also opened — the regex now matches any `NN/NN/NN` in the header, e.g. a slash-form date.

**2. SEVERITY: major (load-bearing) — REPAIR-INDUCED. The falsified coverage-equivalence claim is still asserted, in the same paragraph as its own correction.**

The engineering log now reads *"It catches STRICTLY LESS: a duplicate heading where neither article carries a fingerprint leaves the partition identity satisfied…"* **followed immediately by** *"It catches exactly what a duplicate-name rule catches; the arithmetic form buys resilience to a refactor and nothing else."*

The commit body states "All five sites now state the true scope." Four were corrected by replacement; this one had the correction INSERTED BEFORE the falsified clause, which survives verbatim. This is the shape the registry itself names: *"leaving it standing beside its own refutation was worse than either alone."*

Why the machinery could not catch it: no annotation was added for the retired wording, so it never entered ARM 2a's derived matcher set. **The arming step is the corrector remembering to annotate — willpower, inside the guard whose thesis is Structure > Willpower.**

**3. SEVERITY: major (load-bearing) — PRE-EXISTING (sweep not performed). The gap registry still publishes the retired figure as fact, and now directly contradicts the constitution line the same commit corrected.**

The constitution was corrected to the live figure. `docs/enforcement-gaps.json` (`GAP-alive-but-inert.evaded.how`, untouched) carries the same sentence with the retired percentage. Same case, same sentence, two figures — one live, one from the triple the authority forbids quoting. The commit's triage was scoped to one file. That JSON is in no surface list, and a gap's own `how` field is bound to no freshness digest, so nothing can ever notice.

**4. SEVERITY: major (load-bearing) — PRE-EXISTING. The invisible-payload guard is not at the door its reader-facing account names.**

The explainer says the fix is *"at the point of sending"* and that *"an invisible message is now refused outright."* `hasNoVisibleCharacters` has exactly ONE production call site — the reply route. `sendToTopic` — the actual point of sending — has no such check, and `POST /telegram/post-update` validates only truthiness, type and length.

Proven by execution (probe server, mocked `sendToTopic`, no tone gate): posting a zero-width space to `/telegram/post-update` returns **200 `{"ok":true}` with sendToTopic called once.** That is the route the agent template MANDATES for every ship/restart narration.

**5. SEVERITY: major (load-bearing) — PRE-EXISTING. The countdown guard collects only the FIRST article countdown, so a second, expired declaration passes.** Injection with positional control: a second expired declaration → clean; the identical date in the FIRST position → refused. The sub-obligation arm 60 lines below was fixed for exactly this and carries the comment *"Twice is a pattern, so it is written down here."*

**6. SEVERITY: major (load-bearing) — PRE-EXISTING, not previously reported. The self-counts guard has the identical first-match narrowing — a third site of the same shape.** A second, wrong teeth-count added to an article → clean; the same wrong value in the FIRST position → refused. This is the guard whose entire subject is that a count about itself must be true, and it is the third independent instance of the extractor-stops-at-first-match shape that the constitution names as founding case (2) of *One Failure Teaches Every Guard*.

**7. SEVERITY: major (load-bearing) — PRE-EXISTING. The tree's live claim about refusal-arm coverage is false, and pass 26 suppressed 17 surviving mutants on a tree declaration that does not exist.**

Pass 26 wrote: *"the tree declares refusal-arm coverage at 22 of 84."* Grep for that figure across every delta file returns **only that verdict line**. It appears in no guard, test, log or spec. The tree's only live figure is *"roughly 40% with nothing measuring it"*, derived over 57 sites and 23 tests; there are now **69** sites across six guards and **50** tests, so it is stale on both terms. An independent arm-by-arm census puts live coverage at **19 of 75**, two of whose uncovered entries I verified myself.

**8. SEVERITY: minor — an arm with no test at all, and it is the one that closes the demonstrated exploit.** Deleting the sub-obligation horizon arm leaves all 50 tests green — and with it deleted, setting all 47 sub-obligation countdowns to `9999-12-31` prints clean. That is precisely the pass-17 exploit the horizon was built for, and the constitution's countdowns are 47 sub-obligation to 3 article, so the arm covering 94% of them is the untested one.

**9. SEVERITY: minor — the fingerprint guard's raison-d'être arm is a masked control.** Neutering it leaves all 50 tests green; a new unfingerprinted article is still refused by the shrink-only count arm with a different message. A redundant arm with no negative control, not an open hole — exactly the shape the account guard's own header names.

**10–15. SEVERITY: minor.** A second fingerprint declaration is invisible (same first-match shape). The fingerprint guard states an undated "87 existing articles" where its own clean line prints 82. The gap guard's JSDoc and its implementation comment disagree about what the digest covers, ten lines apart — and the stale JSDoc is what its failure message repeats. The behavioural suite's caption says "four guards" over five describe blocks. Three artifacts publish three different values for one measurement. The gap guard carries an undated surface census where its sibling hedges with a date.

**NITS.** A locational error in the release note ("four lines above"). I could NOT reproduce pass 26's `188/105/83` — I get `188/109/79` raw and `188/102/86` comment-stripped; the population half matches exactly, and I report this as unreproduced-by-me rather than wrong. A duplicated clause on a shipping public docs page. Two files that say "one check now" and then name two arms. The engineering log renders the trajectory as "6 → 2 → 3 → 2 → 1", omitting four values and presenting a non-monotone sequence as falling. The account guard opens "Twenty external review passes" while its own ARM 3 prints 26.

## REGRESSION-CHECK

**(a) Figure parser — NEW-DEFECT.** Stated goal met; the population shifted. Both directions proven with controls. Finding 1.

**(b) Constitution triage — CLEAN.** I re-ran ARM 2b's logic over the constitution under both pre- and post-repair populations. Exactly five line-hits under the correct population: three self-labelled as superseded historical values, one an unrelated count, one the *Earned from* that was corrected. **The triage is exactly right, and no correct line was touched.**

**(c) Release note — CLEAN on the mechanism.** Both cited commands reproduce. The remaining defects in that bullet are locational/numeric nits, not reproduction failures.

**(d) False coverage equivalence — PARTIAL.** The corrected statement is TRUE — I confirmed it algebraically and by injection in both duplicate-heading directions, and the gap record's `why` now agrees with its own `evidence`. But "All five sites now state the true scope" is false: the fifth asserts both. Finding 2.

**(e) Sweep re-reach — CLEAN on its own terms, incomplete as a sweep.** Verified: one article's digest moved, all fourteen occurrences across seven records updated, and the diff is a single line confined to *Earned from*. No verdict's subject matter changed, so the argument holds and no verdict is falsely closed. What it did not do is carry the correction to the twin sentence in the gap registry. Finding 3.

## FRESH-ATTACK-REPORT

**Runtime source, not registry machinery.** Twenty-six passes examined `scripts/` and `docs/`. The delta also contains the invisible-payload module and a block in the server routes. I traced the guard's reach by import, asked "what else calls `sendToTopic` with an operator-supplied body?", and then **booted a probe server** rather than reasoning about it. **New probe nobody has tried: stand up the route harness and fire the payload at the SIBLING route.**

**Applying a guard's logic to the surfaces it does not watch.** I re-implemented ARM 2b and ARM 2a and ran them across EVERY file in the delta under the pre-repair population. That surfaced finding 3 — and cleared ~50 apparent hits as legitimate historical narration, which is what makes the one real hit trustworthy.

**Parse-width sweep across the guard family.** Founding case (2) of the branch's headline article is an extractor that stopped at the first match. I asked which of these guards' own extractors do that. Four sites qualify; three can be walked past. **New probe nobody has tried: place the adversarial input in the SECOND occurrence, not the first.**

**Deleting an arm and watching the suite.** Rather than mutating conditions, I removed whole refusal arms and re-ran the 50 tests — producing findings 8 and 9, and distinguishing them honestly since 9's blast radius is bounded and 8's is not.

**Grepping for the citation, not the claim.** Pass 26 justified withholding 17 mutants by citing a tree declaration. I looked for the declaration. **New probe nobody has tried: when a verdict cites the tree in its own defence, grep the tree for the citation.**

**What answered correctly.** ARM 3 on the ordinal form; the partition arm on both fingerprinted-duplicate halves; the sibling lint catching the half the partition cannot; all three empty-population refusals; the full lint chain; `standards-coverage --check` red for exactly the two documented stale audits. Three peripheral site-docs claims all verified exact. **The tree's structural core is sound; its account of itself is where the defects live — which is where pass 26 said they were.**

## MAGNITUDE-METRIC

**Load-bearing: 7.** Repair-induced: **2** (findings 1, 2). Pre-existing: **5** (3, 4, 5, 6, 7).

Not counted: findings 8–15 and the nits. Finding 5 IS counted although pass 26 declined to — the prompt permits it and it fires with a control.

## TRAJECTORY

`… 3 2 1 4` → **7**.

The nine-pass decline to 1 was the exhaustion of a question. My 7 splits 2 repair-induced / 5 pre-existing, and that split is the story: only two came from asking what the last repair broke, and the four highest-value ones came from places the repair-chase structurally cannot route to.

**The fresh-eyes question is still finding things the repair-chase would have missed, and there is no sign of it running dry.** One reading asked it and found four. A second asked it, in a tree repaired against those four, and found seven — five older than the repair. That is not a residue; it is a different population being enumerated for the second time.

One structural signal worth recording: *stopped reading after the first match* is now confirmed in three of these guards, and it is founding case (2) of the very article this branch introduced to make one failure teach every guard. **The loop that exists to sweep a shape everywhere has not swept its own founding shape through its own machinery.**

## CONVERGENCE

**NOT achieved.** Magnitude did not decline; it rose 4 → 7, five of seven older than the previous repair. Two consecutive fresh-eyes readings produced 4 and 7 against a repair-chase tail of 3, 2, 1. The remainder is not converted: three findings are live false statements in committed artifacts, and finding 7 shows the branch's own coverage figure is both stale and, in the form pass 26 relied on, invented. **A remainder cannot be "named work" while the number describing its size is wrong.**

## COHERENCE

The machinery is again better than its account of it. Every refusal arm I fired with a real input fired correctly except the three first-match narrowings, and the structural core held under everything I threw at it.

The divergences are all in the account: the repository states a coverage figure stale on both terms, and the only other figure in circulation exists solely inside a verdict ABOUT the repository — **the branch cannot currently say how much of its own guard surface is tested.** Two artifacts describing one mechanism disagree in the same paragraph. The constitution and the gap registry now narrate one incident with different figures. A guard header states a population its own clean line contradicts every run. The explainer tells a user invisible messages are refused at the point of sending; one of two doors refuses them.

**The repository's account of the SHAPES it produces is unusually honest — better than most engineering records I have read. Its account of the STATE those shapes are in is not yet reliable.**

## VERDICT

**reject.** Seven load-bearing findings, two introduced by the repair under review and five older than it, including a reader-facing runtime claim that a guard refuses something it does not refuse, two live false figures in committed artifacts, a third guard carrying the branch's own founding failure-shape, and the discovery that the coverage figure used to justify withholding seventeen surviving mutants does not exist in the repository. The trajectory the previous twenty-five readings measured has now been falsified twice. The right next step is not another repair-and-resubmit cycle: it is to measure refusal-arm coverage for real (the number is currently unknown and both circulating values are wrong), sweep the first-match shape through every extractor in the family, and extend the account guard's surface list to the two committed artifacts — the gap registry and `src/` — where this pass found its live defects.
```
