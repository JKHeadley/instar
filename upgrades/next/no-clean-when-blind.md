# Upgrade Guide — No Clean Result While Blind

<!-- bump: patch -->

## What Changed

This fixes four checker paths that could turn missing evidence into a clean
result. The generated-code attribution lint now fails as not proven when an
input cannot be read. Guard-posture monitoring now reports an unknown verdict
when local state is absent or a peer deep read fails. Standards-conformance
review now returns an explicit not-proven conclusion instead of an empty report
or a fit verdict when its reviewer errors or returns malformed output. Failed
Human-as-Detector persistence is now exposed as a structured capture-failure
record and loud error while the user's correction still proceeds.

A repository-wide ratchet now derives the checker population recursively from
production code, refuses empty or unreadable populations, and prevents the
number of checkers without an executable blind-input case from increasing. It
runs through the normal lint pipeline and executes the blind-input cases rather
than trusting a list of test names.

## What to Tell Your User

- **More honest safety checks:** "When one of my checks cannot inspect the
  evidence it needs, I now say the result is unproven instead of reporting an
  all-clear. Your work can still proceed where availability is the priority,
  but a missing review can no longer be mistaken for approval."

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Honest blind-input results | Automatic in attribution, guard posture, standards review, and correction capture |
| Checker-population ratchet | Automatic in the normal lint pipeline |
| Failed correction-capture visibility | Included in the Human-as-Detector summary and structured error output |

## Evidence

The original blind inputs were executed before and after the change. Before,
an unreadable attribution file exited zero; local posture absent plus a throwing
peer deep read returned a passing probe; reviewer errors and malformed output
returned empty findings and fit; and a blocked detector write produced no
failed-capture record. After, those same inputs respectively exit one with
NOT-PROVEN, return a failed NOT-PROVEN probe, return not-proven conclusions and
fit verdicts, and expose a persistence-write-failed capture record plus a
structured error. A recursively planted checker increased the uncovered
population from 91 to 92 and failed the ratchet. Deleting, commenting out, and
superstring-renaming the ratchet each made its own test fail. Focused unit,
integration, and E2E runs passed, and the full lint entrypoint executed all ten
ratchet tests successfully.

## Known Limits

- The new population ratchet freezes current legacy debt at 91 uncovered
  checkers; it prevents growth but does not claim those historical checkers are
  already covered.
- A failed correction write is retained in process memory and written to the
  structured error channel. A storage failure can still prevent durable disk
  persistence by definition.
