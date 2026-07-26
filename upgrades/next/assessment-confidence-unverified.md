<!-- bump: patch -->

## What Changed

**The standards audit's own honesty field was overclaiming, and reported `trustworthy: true` over the
exact defect it was added to expose.**

Verified on the LIVE endpoint two hours after v1.3.975 deployed: `total: 22`,
`enforcedRatio: 0.0455`, **`assessmentTrustworthy: true`**, zero canary failures — while the source
registry carries **81** articles. The stale agent-home copy is not malformed; it is a self-consistent
document that is a quarter of the real one, so it passes every INTERNAL check by construction.

`assessmentTrustworthy` was `total > 0 && canaryOk` — i.e. "my internal checks passed" — but it READ
as "this assessment is trustworthy". Those are different claims.

- **`assessmentConfidence`** (new): `'verified' | 'unverified' | 'untrustworthy'`.
  - `untrustworthy` — a check actively failed (nothing parsed, or the canary objected).
  - `unverified` — internal checks passed but NO external expectation existed to confirm this is the
    CURRENT constitution rather than a coherent older copy.
  - `verified` — internal checks passed AND a same-build expectation matched.
- **`confidenceReason`** (new): always populated, plain English.
- **`assessmentTrustworthy`** — deprecated, retained one release, TRUE only on `verified`.

`'verified'` is **unreachable today**: the expectation mechanism is a separate, not-yet-approved
change. So every passing read now reports `unverified` — including a complete, correct registry,
because the instrument genuinely cannot verify completeness. Anything stronger would be the same
overclaim in nicer clothes.

## What to Tell Your User

If you read a standards-enforcement figure, it now comes with a confidence verdict and a plain
reason beside it. Most installs will see the verdict "unverified" — that is honest rather than a
fault. It means the numbers are arithmetic over whatever copy of the rules was on disk, and nothing
yet confirms that copy is the current one. A verdict of "untrustworthy" means a check actually
failed and the figures describe only a fragment of your rules.

## Known Gap (stated, not resolved)

A coherent stale registry is still reported with real-looking figures; it is now LABELLED
`unverified` with a reason naming that possibility, but the instrument cannot say which case it is
in. Closing that needs an external expectation shipped beside the registry — the blocked
`standards-registry-snapshot-refresh` spec. This change makes the uncertainty visible; it does not
resolve it.

## Evidence

- `tests/unit/standards-enforcement-auditor.test.ts` — a coherent-but-stale registry passes every
  internal check (zero dropped headings, `parsed === articleHeadings`) and still must not read
  `verified`; plus all four `deriveAssessmentConfidence` verdicts in both directions.
- `tests/integration/conformance-dev-gate-route.test.ts` — the HTTP body carries the verdict.
- `tests/e2e/standards-coverage-lifecycle.test.ts` — the verdict + reason survive production init.
