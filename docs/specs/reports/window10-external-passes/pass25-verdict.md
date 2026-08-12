# External review pass 25 — reviewer's verbatim final answer — **ACCEPT**

**The first accept in twenty-five readings — and NOT the finish line.** The operator's protocol requires a
clean reading to be followed immediately by a second reading of the SAME tree with no edits between, and
that PAIR is the finish line. This verdict was deliberately NOT archived at the time, because filing it
would have edited the tree and broken the pair. It is filed here together with pass 26, after the pair
completed.

Pass 25 recorded load-bearing **1** — a new series floor — and credited BOTH clauses of the acceptance
criterion, the second of which seven consecutive readings had failed. **Pass 26 then rejected the identical
tree at load-bearing 4**, and its explanation of the discrepancy is the most important sentence of the
window: *"The decline measured the exhaustion of the repair-chase, not the exhaustion of defects."*

Read this verdict alongside `pass26-verdict.md`. It is preserved verbatim, including its accept, because an
archive that quietly loses a reading it later disagrees with is worth nothing. Run against `baa74e1eb`.

---

```text
# EXTERNAL REVIEW PASS 25 — `echo/window10-deep-property-guards` @ `baa74e1eb`

**Grading rule, declared up front (the passes 17–24 rule, kept verbatim for comparability):** a finding is load-bearing if it either **(i)** leaves a guard unable to refuse an input it claims to refuse, or **(ii)** leaves a committed artifact asserting something false about the machinery. I apply clause (ii) the way pass 24 applied it — as *"checkably false in a committed artifact"* — and name the boundary where the strict reading changes the count.

## FINDINGS

**1. SEVERITY: minor (load-bearing under clause (ii) as pass 24 read it; boundary named; NEW, produced by pass 24's repair) — the branch publishes a reviewer's corpus census on five committed surfaces without re-deriving it, and the corpus falsifies it.**

Pass 24's finding-1 table recorded *"genuine wrapped-sentence continuations (preceded by a non-blank line) — 22"*. The repair copied that figure into five committed places: the guard's own source, the reader-facing explainer twice, the engineering log, and the behavioural test.

Re-derived by me over the surfaces the guard watches, at both `79bcbd48c` and HEAD (identical at each): 0 marker+whitespace bullets; 27 single-star-leading lines; 4 blank-preceded; **23** continuations, not 22; **26** double-star-leading continuation lines also newly stripped; **49** total continuation lines the HEAD rule strips that the pass-23 rule did not.

Two separate errors. Pass 24's arithmetic does not close — 27 minus 22 implies 5 blank-preceded, and there are 4. And the operative class is not the single-star population at all: the rule also strips bold leads, confirmed by input on a real wrap.

Mitigating and worth stating plainly: the error runs in the *unflattering* direction. It under-states the branch's own case by more than half. This is not the "certifies more than it delivers" shape the streak is made of; it is its inverse.

**Boundary:** under the strict reading of clause (ii) this drops → **0**.

**2. SEVERITY: nit — two quotations of archived verdicts are truncated inside quotation marks with terminal punctuation substituted and no ellipsis; one CARRIED, one NEW.** Both are truncations at a clause boundary, which ordinary editorial practice permits; neither rewords nor invents. I swept all italic-quoted spans in the three tracked prose surfaces against the whole archive; these two are the only mismatches.

**3. SEVERITY: nit — "Proven on a real committed line, not a fixture" heads evidence that demonstrates the DEFECT under the two prior rules and never the repair; and at HEAD the sentence beneath it reads backwards.** The claim is true; the evidence offered does not establish it. I ran it: the HEAD rule refuses and the pass-23 rule reports clean, in both directions.

**4. SEVERITY: nit — the guard header's new certifying sentence over-states in the direction opposite to the one pass 24 flagged.** A heading marker is never stripped, whitespace or not, and neither is a hyphen bullet. Zero live instances — 123 hash-leading lines across the three surfaces, none continuation-shaped.

**5. SEVERITY: nit — a residual the repair creates is not among the three the header declares.** A retired wording quoted WITH its leading emphasis marker becomes unmatchable at a wrap. Zero live instances.

**6. SEVERITY: nit (CARRIED) — the superseded mark has two definitions.** The constant drives the escape and every message; the claim derivation hard-codes the pattern. The divergence fails loud.

**No critical findings. No major findings. No defect found in any refusal arm of the four registry guards.**

## REGRESSION-CHECK

All eight claimed repairs (a)–(h) verified CLEAN, with (d) PARTIAL as a class: the named misquotation is byte-exact against its archive once the elision is restored, but a full sweep found two other truncations. The marker rule verified in both directions on the real committed boundary and on two wrap shapes pass 24 did not test. The three emitted-text corruptions verified from the OUTPUT, not the source. The self-count now derives from the same array it iterates, so it cannot diverge again. The archive limb fired twice under my hand.

**Passes 9–24 repairs still hold.** 47-step chain green, 50/50 behavioural, archive 24 files contiguous, 24 rejects 0 accepts. I re-derived the stale-`dist/` attribution and REFINED it: CI runs no build step; the file's own `beforeAll` builds when the artifact is ABSENT — true in CI, false here. The guard is existence-based, not freshness-based.

## MAGNITUDE-METRIC

**Load-bearing count: 1** — finding 1. Under the strict reading of clause (ii) → **0**. No finding at any boundary reaches major, and none is a capability defect.

## TRAJECTORY

`… 3 2` → **1**. Passes 18–25 average 2.13. My 1 is a new series floor. No critical finding for nine consecutive passes; no defect in any refusal arm of the four registry guards for a sixth consecutive pass.

My finding 1 IS new and IS produced by the preceding repair, so the streak becomes nineteen on the letter. What it is not, for the first time, is the thing that streak has meant every previous time.

## CONVERGENCE

**Both clauses met.** Magnitude declining for the seventh consecutive pass, without qualification, on a new floor. Remainder converted to dated named work: every undated finding I have is a nit or a bookkeeping error that misleads no machinery, which the criterion explicitly disclaims as blocking; everything else is on the declared, dated, operator-ruled list, and I reproduced the largest of them rather than taking it on trust.

I considered rejecting seriously, because nineteen would be an easy number to write. I decline it on three grounds: finding 1 is not a capability defect; it errs by understatement; and the criterion names bookkeeping errors that mislead no machinery as explicitly non-blocking.

## VERDICT

**accept.** The magnitude clause is satisfied for the seventh consecutive pass at a new series floor of 1, with no critical finding in nine passes and no defect in any refusal arm in six — a claim I tested rather than inherited. Every repair pass 24 prescribed landed and holds. What I found is one transcribed census wrong by one under the reading it was written in and low by more than half under the reading the code implements — a bookkeeping error consumed by no machinery and erring against its own author — plus five nits. Eighteen readings rejected because a repair left a guard unable to refuse something it claimed to refuse; this reading could not find such a thing, and it looked in the places the last three repairs each re-opened.
```
