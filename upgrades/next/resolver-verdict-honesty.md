---
bump: patch
audience: agent-only
maturity: experimental
---

## What Changed

The MTP red-team harness resolver (`src/redteam/ScenarioPack.ts`) now states its
governance verdicts honestly. Every `ResolvedExpectation` carries a `method`
field (`keyword-heuristic`), and the `reason` strings name their keyword-overlap
basis instead of asserting the verdict as fact — an `ungoverned` result is now
framed as a candidate to verify semantically, not a proven intent gap. The
matching logic is unchanged; only the verdict's self-description.

## What to Tell Your User

Nothing user-facing changes. This is an internal correctness fix to an
experimental capability: the red-team harness no longer overstates a crude
keyword-match result as a definitive finding.

## Summary of New Capabilities

- `ResolvedExpectation.method` field for provenance of every governance verdict.
- Honest verdict `reason` strings (keyword-overlap basis named; `ungoverned`
  framed as candidate-to-verify).

## Evidence

Not a behavior change to classification — a truthfulness fix to the verdict
text + a provenance field, required by the Truthful Provenance standard (#896).
The brittleness it makes honest about was observed live: a false-negative
`ungoverned` verdict on the first boundary map. Verified by 26 unit tests
(one new, asserting method-provenance and that the as-fact phrasing is gone) and
a clean `tsc --noEmit`.
