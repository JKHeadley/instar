<!-- bump: minor -->

## What Changed

Spec #4 of the cartographer-conformance project — **fixes a real defect in the
convergence gate and makes the report-backed converging audit the structural
default** (dark, off by default).

The defect: the formal initiative gate (`StageTransitionValidator`) required the
`review-convergence` frontmatter tag to equal the boolean `true`, but the actual
converging-audit tooling writes an ISO **timestamp string**. A timestamp is not the
boolean `true`, so the formal gate **rejected every properly-converged spec** at the
`spec-drafted → spec-converged` transition — quietly broken. This change adds a pure
`isConvergenceTagPresent` predicate that accepts the canonical timestamp (and still
the legacy boolean), used as the single definition of "the tag is present."

On top of the defect repair, a new default-off flag `specReview.requireConvergenceReport`
makes the converging audit's **report** (the proof it actually ran) a requirement of
the commit-time gate when enabled — so "converged" can mean "the audit ran and left a
report," not just "a tag was added." The commit-time gate reads the flag via an
environment variable (it runs before compilation and reads no config), exported from
config by the husky hook; when unset, the commit-time gate behaves exactly as before.
The formal gate's existing report requirement is left unconditional, so enabling the
flag brings the two gates into agreement — and a cross-gate consistency test makes it
impossible for them to drift apart. Whether an outside model also reviewed a spec is
surfaced in the gate's diagnostics, never required.

## Evidence

- **Before:** a spec converged via the real tooling carries
  `review-convergence: "2026-06-10T…"`. Feeding it to the formal gate returned
  `CONVERGENCE_TAG_MISSING` because `"2026-06-10T…" !== true` — the `spec-drafted →
  spec-converged` transition could not advance any real spec. (The existing tests only
  ever fed the boolean `true`, which is why the defect shipped unnoticed.)
- **After:** the same timestamp-tagged + reported spec advances through the real
  `POST /projects/:id/advance` route (new integration test); a timestamp-tagged spec
  with a MISSING report still returns `CONVERGENCE_REPORT_MISSING` (the existing,
  unchanged check); and a new predicate test covers timestamp / boolean / empty /
  missing.
- **Back-compat verified end-to-end:** a test runs the real commit-time gate script —
  with the flag unset, a timestamp-tagged + approved spec with no report commits
  cleanly (identical to today); with the flag on and no report, it is blocked; with
  the report present, it commits. This PR's own commit passes through the modified gate
  with the flag off.

## What to Tell Your User

- **The review gate was quietly broken — now it's fixed and means something**: "The
  check that confirms a design was properly reviewed before it ships had a bug — it was
  looking for the wrong marker, so it actually rejected every correctly-reviewed
  design. I repaired it, and added an opt-in setting that makes 'reviewed' require the
  review's report to actually exist, not just a tag. It's off by default, so nothing in
  your current workflow changes until you turn it on."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Report-backed convergence gate | `specReview.requireConvergenceReport: true` in config (opt-in; off by default) |
| Correct convergence-tag recognition | automatic — the formal gate now accepts the canonical timestamp tag |
