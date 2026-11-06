# Review: Amendment 6, owned-machine Pending exception (2026-11-06)

## What changed
`docs/STANDARDS-REGISTRY.md`, article *An Instar Agent Is Always a Multi-Machine Entity* (area: Building): the survivability pointer, the Amendment 6 clause in the Rule, the posture sentence, and the enforcement status in **Applied through**. It supersedes unmerged PR #2796, which rested the exception on an outside witness. The earlier approval was for that draft: "Yes, A. Approved please proceed" [source: telegram 137342/138625 2026-11-05]. The later ruling is why it is replaced: "we should never ever ever require anything that forces the user to purchase a third-party service" [source: telegram 136110/139094 2026-11-05]. This wording has no operator approval yet.

## What I checked
Two independent reads by GPT-6 Astra (a different model family) through the charter launcher, against the brief, the owned-custody design, #2796's text, the governing articles and the Telegram log. Standards coverage run before and after.

## Findings
- F1, applied (round 1, must-fix): "the owner records them as lost" closed the debt, which the design does not allow ("Unknown pending source stays explicitly unresolved"). The owner may now record the loss, but that does not resolve or cancel the debt. The ELI16 says the debt can stay open indefinitely.
- F2, disposed (round 1, must-fix, review setup): the charter's `scripts/check-architecture.mjs` belongs to 2.0 and does not exist here. Recorded as not applicable to a 1.x text change; the check did not run and is not claimed as passed. Astra accepted this in round 2.
- N1, declined (note): paragraph breaks in the clause. The article's fields are kept in their existing form. The reason I first gave, that the parser reads a field as one line, was wrong; the parser joins lines. This is a formatting choice only.

## Verdict
Round 1 returned NO on F1 and F2. Round 2 returned YES, 0 must-fix, 1 note. Both quotes match the log. The direction guard waits on the operator's approving review; no direction, provenance or area gate is changed or waived.
