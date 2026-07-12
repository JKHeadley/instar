<!-- bump: patch -->

## What Changed

The LLM-decision-accountability audit reached formal convergence. A third independent four-slice re-sweep of the full LLM-decision-point surface (gates / sentinels / extractors / reviewers-judges) returned zero previously-uncatalogued systemic categories, so the audit report now carries the machine-earned `converged:` stamp — written by the validator (`scripts/write-audit-convergence.mjs`), not by hand. This is a documentation-only convergence: no runtime behavior changes, and the three tracked remediation efforts (ACT-1193 provenance, ACT-1194 outcome-grading, ACT-1195 bench-parity) remain open.

## What to Tell Your User

Nothing changes for you — this is an internal documentation milestone. It records that a thorough audit of how instar tracks its own AI-judgment decisions is now complete and its conclusions certified. The separate work to close the gaps the audit surfaced is tracked and continues.

## Summary of New Capabilities

- No runtime capabilities. Documentation-only: `docs/audits/llm-decision-accountability.md` now carries a validator-earned `converged:` stamp (3 rounds; new-findings/round 3 → 6 → 0).
