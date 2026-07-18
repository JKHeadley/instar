<!-- bump: patch -->
<!-- internal-only -->

## What Changed

- Added `docs/apprenticeship/PROGRAM-CONCEPTS.md` — the canonical statement of the
  apprenticeship program's four operator-ratified concepts (mutual substrate
  improvement; role asymmetry, not capability asymmetry; fractal role-teaching;
  required fundamental-gap analysis on defects) plus two bounded evaluation cautions
  (tripwires-not-targets hidden testing; multi-cycle promotion evidence). Origin:
  operator directives, topic 29723, 2026-07-16/17 (CMT-872).
- `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md`: the §13.1 issue schema gains three
  REQUIRED fields — `rootGapInfrastructure`, `rootGapSentinel`
  (failing | missing | neither-unpromoted), `rootGapStandard` — and a new §13.9
  defining the write-time requirement: a defect record without root-gap analysis is
  refused, like a record without a bucket.

## Evidence

- Docs-only diff: `docs/apprenticeship/PROGRAM-CONCEPTS.md` (new),
  `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (schema + §13.9),
  ELI16 at `docs/specs/cmt872-apprenticeship-concepts.eli16.md`,
  side-effects review at `upgrades/side-effects/cmt872-apprenticeship-concepts.md`.
- The three-question analysis is already applied live in apprenticeship drive 5's
  defect matrix (defects #9, #10, #11) — this lands the canonical documentation and
  schema definition for it.
