# Empty aggregate histories no longer report a fabricated zero percent

## What Changed

Dispatch acceptance and job-pattern success reports now return an unavailable
value when no decisions or runs exist, instead of reporting a measured zero.

## Evidence

- Focused unit tests cover both empty histories and non-empty calculations.
- The repository typecheck confirms every arithmetic reader handles the
  nullable contract.

## What to Tell Your User

Internal reliability summaries now distinguish “nothing measured yet” from a
real zero-percent result.

## Summary of New Capabilities

- Honest empty-denominator handling for the final two ACT-1243 rate producers.
