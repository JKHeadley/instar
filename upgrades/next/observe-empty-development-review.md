## What Changed

Added an off-by-default observation for scheduled development reviews. When enabled, it records whether a review with no work could have been skipped, next to that run’s actual token use. The review still launches; this trial does not skip work.

## What to Tell Your User

Development reviews behave as before by default. If you enable the observation, it records whether an empty review might have been skipped without changing whether the review runs.

## Summary of New Capabilities

An optional, observe-only record for empty development reviews; review execution remains unchanged.
