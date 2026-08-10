# External review pass 17 — reviewer's verbatim final answer

**ARCHIVED LATE — the EIGHTH lapse, and the third consecutive one.** Review pass 18 found it: sixteen
verdict blobs in all of git history, pass1–pass16, no pass 17. So every claim made about pass 17 —
including "six load-bearing" and its headline that no guard had a behavioural test — rested on my prose
alone at the moment I made it. Each of the last three has been filed only after the NEXT reviewer pointed
at it, which is the finding: the convention is not holding by intention.

Pass 17 is the pass that named the structural cause of the whole streak. Run against `ebf98f36d`.
Exploration logs are NOT kept; only the final answer block.

---

```text
FINDINGS

1. SEVERITY: major — the horizon was added to one countdown guard and not swept to its sibling, which governs the constitution's own 50 countdowns and accepts 9999-12-31 while printing clean. The sibling validates a countdown's shape and compares it against TODAY with no upper bound. Proven by injection with a working control: pristine → clean; one article countdown → 2020-01-01 → RC=1 "countdown EXPIRED"; one article countdown → 9999-12-31 → RC=0 clean; all 48 sub-obligation countdowns → 9999-12-31 → RC=0 clean; all 50 → 9999-12-31 → RC=0 "clean … soonest 9999-12-31". The guard announces the state in its own clean line and does not object. This is verbatim the property the new horizon exists to enforce, and it defeats the operator ruling that guard was built for. This branch's headline mechanism is One Failure Teaches Every Guard — Record the Shape, Sweep It Everywhere, and the shape was not recorded as a gap, so the sweep could not reach it.

2. SEVERITY: major — the repair falsified a comment it did not update, in the file the repair reasoned from. baseline-history.mjs states "The expiry decision stays with the CALLER, which is where the sibling lint-documented-only-countdown already puts it … Same division, one date rule." At HEAD the two callers no longer share one date rule. The sentence was true at the parent and was made false by this commit. The horizon comment explicitly cites this sibling as its precedent, so the author read the adjacent guard while making the change and updated neither it nor the comment about it.

3. SEVERITY: major — the withdrawn "imported verbatim" claim survives in the file the registry now cites by path to substantiate the withdrawal. The registry's corrected sentence is true and verified. But the instrument's own header still reads "imported verbatim, not re-typed", and the side-effects log still reads "imported VERBATIM rather than re-typed". The claim was withdrawn in 1 of 3 places, and the registry's new citation points a reader straight at one of the two survivors.

4. SEVERITY: major — the commit announces three corrections in an artifact to which it applied none of them, appending the announcements above the uncorrected text. git show --numstat → 54 0 on the side-effects log: insertions only, zero deletions. The "second of eight records" line still stands (there are 7). The retracted "the ordinals are dropped rather than restated" wording still stands. That surviving sentence also carries a wrong number: node-only ordinals are 35 and 44, not 35 and 43 — wrong at the parent too. This is pass 16's own finding reproduced in the commit that repaired it, three times.

5. SEVERITY: major — pass16-verdict.md does not exist, and its repairs have already landed. Seventh archive lapse, and the first where the verdict is absent while its repairs are in the tree, so every claim the commit makes about pass 16 is unauditable.

6. SEVERITY: major — none of the four window-10 guards has a single behavioural test; the horizon arm has neither a test nor any live data that reaches it. A grep across tests/ for the four guards returns exactly one file, and its four references are list-membership assertions that the scripts appear in the chain. No test executes any refusal arm. All 7 gap records are swept, so leg 4 is unreachable on the live population; its only proof is one manual injection recorded in prose. alive-but-inert is a recorded gap shape in this very repository. Pre-existing lints of comparable weight DO carry behavioural tests, so this is not repo convention. No prior pass raised this. It is the structural explanation for a ten-pass streak of repair-introduced defects: there is no regression net, so each repair's correctness rests entirely on the next external reviewer.

7. SEVERITY: minor — the two culminating artifacts use incompatible staleness conventions, and the ELI16 explainer opens on the window's original wrong headline. Ground truth at HEAD is 217 / 201. A case-insensitive grep for "superseded" on that file returns 0.

8. SEVERITY: nit — "the LOWEST reading of the series" is a tie presented as a unique low; pass 9 also recorded 3.

9. SEVERITY: nit — a wrong number was removed without being recorded as wrong.

10. SEVERITY: nit — the 180-day horizon is 6x the repository's own countdown convention. The author labels it "a CHOSEN number", which is the honest move, but the asymmetry against the only precedent is unexplained.

Critical: none.

REGRESSION-CHECK

(a) 180-day horizon — NEW DEFECT (two). The arm itself is correct: a three-direction probe with true exit codes gives three distinct reasons and correct inclusive boundaries at both ends. canonicalFutureDate has exactly one caller repo-wide, so no other caller is affected. But the repair introduced findings 1 and 2.

(b) the ~8% deletion — CLEAN. 14 tokens, 5 distinct, matching the article's own enumeration. Table re-derived independently; all internally consistent, and the committed instrument reproduces 201/49/25/15 to the digit.

(c) pass-15 archived alone, before repairs — CLEAN. But the convention broke again for pass 16.

(d) gaps count + hadNoFingerprint — CLEAN in the JSON, NEW DEFECT in its sibling.

(e) ordinals sentence — CLEAN in the guard, NEW DEFECT in its sibling.

(f) "copies", instrument cited — PARTIAL, NEW DEFECT (finding 3).

Pass 9 through pass 16 repairs re-tested by injection — all HOLD. Full 46-step lint chain: green. Test state re-derived rather than inherited: five failures are stale local dist (the beforeAll builds when dist is ABSENT, i.e. in CI, but not when stale), one is the deliberately-red areaAudit assertion. Pass 15's "no reading makes this green" is over-stated.

MECHANISM-CHECK

(a) PARTIAL. (b) CLOSED. (c) CLOSED for pass 15; the class is OPEN. (d) PARTIAL. (e) PARTIAL. (f) PARTIAL.
Four of six are PARTIAL, and every partial fails the same way: the correction landed in one artifact and not in its sibling.

MAGNITUDE-METRIC

Load-bearing findings: a finding that either leaves a guard unable to refuse an input it claims to refuse, or leaves a committed artifact asserting something false about this branch's own machinery. This pass: 6 — 5 NEW, 1 pre-existing (finding 6, never raised in sixteen passes).

TRAJECTORY

Load-bearing 1 to 17: 4 4 5 4 4 4 4 4 3 5 5 5 5 6 5 3 6.

Is magnitude genuinely declining? No. Pass 16's 6 to 5 to 3 was the first two-step decline, and its third data point cannot be audited because that verdict was never committed. Against my metric the current reading is 6. More decisive than the count: the generator has not weakened. The defining shape — announce a correction, apply it in one place, leave it standing in its siblings — recurred three times in one file, in the very commit whose subject line is "the figure I said I withdrew".

There is one genuine improvement worth stating plainly: the guards themselves are holding. Every injection I ran was refused correctly, the chain is green, the horizon is correct in all three directions, and every published figure I re-derived reproduced to the digit. The failure is no longer in the machinery — it is entirely in the repository's account of that machinery, and in the absence of any test that would let the machinery defend itself against the next repair.

CONVERGENCE

Not met. Five NEW load-bearing defects were introduced by the repairs since pass 16 — the eleventh consecutive pass at which the previous repair introduced a new one. The dated-remainder clause is closer to satisfied than at any prior pass and I credit it. But finding 1 is a live hole in a guard running in CI right now, and findings 3 and 4 are false statements in committed artifacts, one of them the citation target the same commit added. These are defects to fix, not remainder to schedule.

What blocks acceptance is narrower and harder: the repair process still cannot make a correction without leaving a copy of the retracted claim somewhere it will be read. Until a repair sweeps its own claim the way the gap loop is supposed to sweep a failure-shape — and until something in CI can fail when it doesn't — the next pass will find the next instance.

COHERENCE

No. The machinery is in better shape than the account of it. Four verified divergences at HEAD: the registry says the instrument copies while the instrument says it imported; baseline-history says the two callers share one date rule when they no longer do; the countdown guard's header says it makes the silent permanent gap impossible while all 50 countdowns can be set to 9999 and it prints clean; and the side-effects artifact announces three corrections its own earlier lines do not carry.

VERDICT

reject. The guards are sound and better than at any prior pass: every pass 5 to 12 injection was refused, the 46-step chain is green, the horizon arm is correct in all three directions with exact inclusive boundaries, the ~8% withdrawal is genuinely complete within the article it was scoped to, and every published figure I independently re-derived reproduced exactly. The dated-remainder half of the criterion is close to satisfied and I have held none of the known-open items against this verdict. But the repairs made since pass 16 introduced five new load-bearing defects, and four of them are the same defect: a correction applied in one artifact and left standing in its siblings — including three instances inside the single commit whose subject line is "the figure I said I withdrew". The horizon repair itself, while correct, was not swept to the adjacent guard that governs the constitution's own fifty countdowns, which now accepts 9999-12-31 and prints clean — a live hole in CI, in the exact shape the repair was written to close, in a branch whose headline mechanism is One Failure Teaches Every Guard. Underneath all of it sits the thing sixteen passes never named: not one of the four new guards has a single behavioural test, so nothing in this repository can fail when a repair breaks one, and each fix's correctness depends entirely on the next external reviewer noticing. That is why this streak has run eleven passes, and it will not end by finding defects faster.
```
