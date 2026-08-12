# External review pass 12 — reviewer's verbatim final answer

Committed ALONE, before any repair — the second pass for which that is true.

Pass 12 is the twelfth reject and **the first with no defect in the machinery at all.** Every attack was
refused, every negative control fired the right way, and every pass-8/9/10/11 repair held under re-test.
All five load-bearing findings were in the ACCOUNT: prose and stored verdicts describing machinery that
had changed underneath them. The reviewer named the shift — the generator moved from *"the fix opens a
hole"* to *"the fix changes the code, re-stamps the digest, and never re-reads the verdict the change
invalidated."*

Run against the frozen tree at `038a374b3`. Exploration logs are NOT kept; only the final answer block,
verbatim.

---

```text
FINDINGS

1. SEVERITY: major — The constitution and the gap record still certify a two-arm mechanism whose first arm the freeze commit deleted, and the gap-propagation loop cannot see it. `docs/STANDARDS-REGISTRY.md:684` states, present tense: "The second repair is therefore deliberately not another duplicate-name rule but the partition identity … which holds however an article goes missing … Both arms carry a negative control: the name arm was fired by each attack, and the partition arm was fired by injecting a dropped bucket entry." `docs/enforcement-gaps.json` `GAP-name-keyed-population-collision.sweep.matched[0].evidence` states "duplicate-without-fingerprint now refused by the name arm … and the partition arm PROVED REACHABLE by injecting a silently-dropped bucket entry." In the frozen tree there is no name arm — `038a374b3` deleted the last one (`dupFingerprinted`, after `8694179c2` deleted `distinctNames`) — and the cited "proof" is the source-mutation the author's own commit body repudiates ("That is not a negative control; it is proving an `if (false)` branch works by changing it to `if (true)`"). `git log 49e6a4d3e..HEAD -- docs/enforcement-gaps.json` shows the only edits were 12 digest re-stamps; `why`/`evidence` are byte-unchanged since `d65fce054`. The script comment was rewritten in full; the two durable artifacts other guards read were not. And nothing can catch it: I neutered both refusals in the cited guard (`if (false)` on the partition and the dialect check) and `lint-enforcement-gap-records` still printed `clean — 6 gap(s), 6 swept`. Staleness is keyed on the registry article body (`atDigest`), never on the cited guard's source, so a guard can be gutted with every sweep green. This is the record whose own text says "complying with the guard's own instruction was the step that completed the exploit" — re-pasted digest, unread verdict.

2. SEVERITY: major — `findIndentedHeadings` closes the demonstrated instance and certifies an invariant that is false. `scripts/standards-registry-article-core.mjs:79-81`: "Refusing the ambiguous form keeps a single grammar: a heading either starts at column zero and is seen by everything, or the build fails and says why." Executed against the frozen tree: appending `- ### List Item Standard` — which this repo's own `marked` renders `<ul><li><h3>List Item Standard</h3></li></ul>` — leaves `lint-enforcement-fingerprint` (88 articles), `lint-no-duplicate-definitions`, `lint-registry-self-counts`, `lint-enforcement-gap-records`, `lint-documented-only-countdown` all exit 0 and `standards-coverage --json` `total=88`. `1. ### X` and raw `<h3>X</h3>` behave identically. `> ### Blockquoted Standard` is sharper still: `lint-no-duplicate-definitions` counts 89 articles while the fingerprint lint, self-counts and coverage count 88 — a live population disagreement between two guards over one document, with nothing failing. The docblock's explicit Scope paragraph ("stated because pass 11 punished exactly this kind of unstated scope") names only fenced blocks; the blockquote skip at `standards-registry-article-core.mjs:34` and the list-item blindness are unstated. No false positives found: fenced, HTML-commented and 4-space cases stay clean.

3. SEVERITY: major — the "orphaned is not abandoned" amendment asserts an unmeasured magnitude that the guard's own instrument bounds in one pass, in the paragraph whose stated discipline is to size residuals. `docs/STANDARDS-REGISTRY.md:170` now says "the most ordinary way a promise is genuinely kept is to write a file whose header cites the promise it fulfils … an unknown share of the 201 are kept promises whose only trace is a header comment" and "overstates abandonment by an unmeasured amount." Measured by replaying the shipped corpus rules over the 201 orphans without comment-stripping: 25 of 201 appear anywhere in the resolving corpus; 15 of 201 in `src/`+`tests/` (the exact mechanism named); 0 in `.instar/` decision records; and 49 of 201 carry no id-shaped token at all. So the "unknown share" is bounded at ≤12.4% (≤7.5% for the named mechanism), 186 of 201 have no such file anywhere — which contradicts "the most ordinary way" — and it cost one ~40-line pass to establish. Two sentences later the same paragraph says "Sized so a reader can judge the residual instead of taking 'weaker' on trust."

4. SEVERITY: major — the registry's central certification about resolution is still false and now contradicts a sentence added beside it. `docs/STANDARDS-REGISTRY.md:170` still states "the PRINCIPLE was adopted instead: prose and comments do not resolve a referent — only executable or structured evidence does." The same paragraph, added by `77568504f`, now also states "The prose resolution is a false positive." Probe reconfirms the hole is live: a tracked repo-root `{"note":"ZZZ-90105 is deferred, this is prose inside JSON"}` resolves a brand-new marker, while `ZZZ-90101` (`a:// …` in `.ts`), `ZZZ-90106` (`#` in `.yaml`) and a compound pair all correctly orphan. Declining the mechanism repair is defensible on the author's evidence; leaving the falsified sentence standing while adding its own refutation to the same paragraph is not.

5. SEVERITY: major — the required coverage gate still rejects the submitted state; fifth consecutive pass. `node scripts/standards-coverage.mjs --check` → exit 1 on Building and The Substrate. The current SHAs differ from the ones pass 11 recorded, i.e. the post-pass-11 repairs re-staled the audits. Genuinely dated, but the branch as submitted cannot go green.

6. SEVERITY: major — the three ratchets still constrain nothing here. All three baselines ABSENT from origin/main; `readPinnedBase` returns `establishing` on `REQUIRED=0`. Carried unchanged from passes 7/9/10/11; dated. Graded major to keep the cross-pass series comparable.

7. SEVERITY: minor — a sub-obligation countdown that omits one literal trigger phrase is invisible to every arm of the countdown lint, including expiry. `scripts/lint-documented-only-countdown.mjs:219` gates collection on `text.includes('UNENFORCED SUB-OBLIGATION')`. Injected an expired countdown with a duplicate id into an article with no trigger: lint clean. The header's "MEASURED — … (2) no declared deadline is in the past" is false as written. Latent today: all 48 live countdowns are collected, and back-dating a collected one still fails.

8. SEVERITY: minor — `lint-enforcement-gap-records.mjs:67-68` claims a refusal it does not implement. "The population is now refused when two articles share a heading, so the sentence is earned rather than hoped." Attack B → `clean — 6 gap(s), 6 swept`. Its actual refusal is the fingerprint-duplicate half only — the same shape that was deleted from its sibling as redundant.

9. SEVERITY: minor — this branch quotes a figure the branch itself forbids quoting. `tests/unit/lint-chain-completeness.test.ts:52`: "62% of tracked deferrals did not." `scripts/lint-deferral-referent-resolves.mjs:22-26`: "Do not quote either."

10. SEVERITY: nit — parser divergence inside one lint file. `lint-enforcement-fingerprint.mjs`'s article splitter handles neither HTML comments nor blockquotes, while `visibleRegistryLines` (used by its own dialect check) handles both. Safe direction (over-refusal), but it is two grammars in one file.

11. SEVERITY: nit — `if: always()` also runs on cancellation; `!cancelled()` is the idiom that does not. Carried from pass 11, unchanged.

Critical: none. Class empty.

REGRESSION-CHECK

(a) fingerprint-lint consolidation — NEW DEFECT (in the account, not the mechanism). The mechanism is sound and I verified it in both directions. The claim "the partition identity ALONE refuses both halves" is TRUE: algebraically the refusal fires iff a duplicated heading has ≥1 fingerprinted article — a strict superset of the deleted condition. Attack A → PARTITION BROKEN, exit 1. Attack B → identical, exit 1. Negative control fired by REMOVAL, not mutation: replacing the condition with `if (false)` makes both attacks pass clean — the first genuine negative control this arm has ever had. The new defect is finding 1.

(b) findIndentedHeadings — NEW DEFECT (false class certification). Instance closed and verified at 3-space and 1-space, no false positives on fenced, HTML-commented or 4-space content. New defect is finding 2.

(c) duplicate tracked countdown id — CLEAN. Same-space and cross-space duplicates both refused. 48 tracked entries, 48 distinct ids. The published count is now a count of obligations. Finding 7 is a pre-existing collection gate, not something this repair introduced.

(d) ci.yml claim correction — CLEAN. `npm run lint` → exit 0, all four registry lints clean at the tail; the `lint` job runs it; `readPinnedBase` returns `local-unbound` and returns early, so the pinned-base-bound invocation genuinely had never run. The falsehood pass 11 found is explicitly retracted. No new defect.

(e) the deliberate non-repair — NEW DEFECTS (findings 3 and 4). The factual claim is TRUE and I reproduced it: `CMT-1785` appears in 12 corpus files; after `withoutComments` it survives only in the two decision records. All four dedicated test files are stripped, as claimed. The reasoning about the fix is TRUE: dropping that corpus makes it an orphan, 201→202, failing the shrink-only arm. The reasoning about the consequence is over-claimed (finding 3), and the falsified sentence was left standing beside its own refutation (finding 4).

Pass-9, pass-10 and pass-11 repairs all still hold under re-test.

MECHANISM-CHECK

(a) CLOSED as a mechanism, OPEN as a certification.
(b) PARTIAL — indented form genuinely refused with no false positives, but the evasion class is not closed and the file certifies otherwise.
(c) CLOSED.
(d) CLOSED.
(e) OPEN, deliberately — correctly so on the mechanism, incorrectly on the account.

MY-ACCOUNT-CHECK

Independently re-derived: 5, 7, 6, 4, 4, 4, 5, 5, 5, 6, 6 major-class findings; all eleven reject. Matches the author's table exactly. No numerical discrepancy.

Three discrepancies:
1. Commit `8694179c2` claims "NOW ONE CHECK" while that commit carries both `dupFingerprinted` and the partition — two refusals. Self-corrected one commit later, but the headline was false when written.
2. The third collision case (both articles unfingerprinted) is NOT caught by the surviving refusal; it is caught by the shrink-only arm and the sibling lint. Net coverage unchanged; the attribution in the freeze narrative is narrower than it reads.
3. The prompt's known-open list is accurate. All three items carry real, dated, biting countdowns.

MAGNITUDE-METRIC

Load-bearing enforcement integrity — defects that let a guard, ratchet, test, or evidence artifact certify a condition it has not established (including certifying machinery that no longer exists). Unchanged from passes 5–11.

TRAJECTORY

Load-bearing, passes 1→12: 4 → 4 → 5 → 4 → 4 → 4 → 4 → 4 → 3 → 5 → 5 → 5.
Raw major, passes 1→12: 5 → 7 → 6 → 4 → 4 → 4 → 5 → 5 → 5 → 6 → 6 → 6.

Flat on both series. Sixth consecutive pass finding new load-bearing defects inside the previous pass's repairs.

But the composition changed, and this is the real signal. For the first time in the series I found ZERO mechanism defects. Every attack that matters is refused; every negative control I could construct fired the right way; four of five repairs are mechanically sound and one of them has the best-evidenced control of the whole run. All five new load-bearing findings are in the ACCOUNT. The generator is no longer "the fix opens a hole" — it is "the fix changes the code, re-stamps the digest, and never re-reads the verdict the code change invalidated." That is a narrower and more tractable failure than any previous pass reported, and nothing in the repo currently binds a recorded verdict to the source it is about.

CONVERGENCE

No — not yet, and by a smaller margin than at any prior pass.

The second half of the criterion is now genuinely met: 48 tracked countdowns, expiry proven to fail the build, and all three known-open items dated and named on the articles they belong to.

The first half is not. Magnitude is flat at 5 for a third consecutive pass, and the blocking condition is unmet for the sixth time. Three of this pass's five are inside the pass-11 repairs, and one sits in the constitution itself. Separately, the branch still cannot go green, and the post-pass-11 repairs re-staled those audits.

What would flip it, in stream terms:
1. One pass that finds nothing new inside the previous pass's repairs.
2. The prose verdicts brought into agreement with the frozen code — four sentences. No new machinery, and the freeze makes it a pure-subtraction edit.
3. Something that binds a recorded verdict to the guard it is about.
4. The gate must be able to go green.

COHERENCE

No. Six mismatches, each verified by execution: the two-arm certification over a one-arm guard; the gap record's "refused by the name arm"; the false heading-grammar universal; the "prose and comments do not resolve" sentence beside its own refutation; "unmeasured amount" when it measures in one pass; and the gap-records header claiming a refusal attack B walks through.

The candour remains unusual and real, and this pass's repairs are the best-evidenced of the run. But the correction discipline is applied to script comments and the append-only log, and not to the two artifacts that other guards actually read.

VERDICT

reject. This is the strongest pass of the twelve on mechanism and the first with no mechanism defect at all: the consolidation is a genuine subtraction whose negative control I fired by removing the check rather than mutating it, the indented-heading refusal bites at one space with no false positives, the duplicate-countdown-id refusal holds across both id spaces jointly, the ci.yml claim is now accurate, and every pass-8/9/10/11 repair still holds under re-test. The author was also right to refuse pass 11's proposed fix, and I verified the factual basis independently. But the change is certification machinery, and its defects moved rather than shrank: the freeze commit deleted the last name-keyed arm and left the constitution and the gap record certifying, in the present tense, a two-arm mechanism with two negative controls — one arm gone, one control disowned — while re-stamping the freshness digests in the same commit, and I proved the loop cannot notice by gutting both refusals with 6 gaps, 6 swept still green. The new dialect refusal certifies that a heading is "seen by everything or the build fails" when a list-item `###` renders an `<h3>` past all five lints. The one increment written entirely about a number's meaning declared the magnitude unmeasured when 25-of-201 falls out of the guard's own corpus rules in a single pass, in the paragraph whose stated rule is to size residuals. Load-bearing magnitude is flat at 5, raw majors flat at 6, the sixth consecutive pass has found new load-bearing defects inside the last pass's repairs, and standards-coverage --check still exits 1 on audits the repairs themselves re-staled. The criterion asks about the stream; the stream has changed shape — from broken mechanisms to stale accounts of working ones — but it has not converged.
```
