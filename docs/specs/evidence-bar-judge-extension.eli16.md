# A Claim Is Not Evidence — For the Judges Too (Plain-English Overview)

## What this is

I already live under a rule that says: don't claim "tests pass" unless you actually ran them and saw the output. But several of my AI checks exist to JUDGE such claims — "did this session really finish its work?" — and those judge-prompts were never told the same rule. The benchmark caught the result: a judge credited an agent's bare "tests pass" (no output shown) as proof, on five different model routes.

## The problem we hit

The evidence rule stopped at the claimer's mouth. The judge had no definition of evidence at all, so models defaulted to being polite and crediting the claim. Important nuance we ALSO measured: the first fix over-corrected — it made judges so strict they started rejecting REAL evidence on six routes, and our A/B safety net refused to ship it. So this class has two ways to fail: too trusting AND too suspicious.

## The fix

Extend the existing evidence rule to cover both mouths. Judge-prompts get one shared, tested sentence: "a claim is not evidence — credit it only on shown output or checkable results; but if real output IS shown, it counts." And every claim-judging check must be benchmarked in BOTH directions: a trap case with a bare claim (must refuse) and a case with genuine evidence (must accept). The too-strict failure gets a permanent test, not just a memory.

## What changes for you

Nothing visible. Judge prompts migrate one at a time through A/B testing; the hardest one (the completion judge, where three wordings have already failed honestly) goes LAST, after easier judges de-risk the wording. The registry text changes only with your sign-off.

## Open questions (your call, stated simply)

1. **Should routing be part of the rule?** We measured that the SAME model judges claims well through a clean door and credulously through the Claude-Code door. We propose keeping "which door" in the routing registry (already done) rather than baking it into this standard — agree?
2. **How detailed should "evidence" be?** One sentence ("shown output counts, bare claims don't") versus a fuller checklist per claim type. Longer costs tokens on fast checks; A/B will measure it — any floor you want set in advance?
3. **Score-based judges.** Some judges output scores (like a 1–10 quality grade), not verdicts. Should the same trap cases apply with a rule like "a bare claim must cost at least N points"?

## What the multi-reviewer process changed

Three rounds sharpened the honesty and the edges. (1) The spec now says plainly what a prompt rule CANNOT do: a judge can't tell a real test log from a fabricated one — prompts govern what is SHOWN; deterministic verification (actually re-running the command) governs what is TRUE, and the standard names that split. (2) Judges are now classified by what KIND of claim they judge (completion vs health vs scoring), because those need different evidence. (3) For scoring-style judges, a bare claim must cost real points — with a program-wide minimum so a token penalty can't fake compliance. (4) Test batteries must include realistic GOOD evidence in the forms the judge actually sees (not just transcript snippets), because the measured failure of the first fix was judges becoming too strict and rejecting truth. (5) *Round 3:* for scoring-style judges, penalizing a bare claim isn't enough — the penalized score must also land BELOW the passing line. Before this, a bare claim could lose its N points and still pass (75 points against a 70-point bar), which quietly credits exactly what the rule forbids; the arithmetic of the two settings together is now machine-checked.
