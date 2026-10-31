## What Changed

New queue pace measurement: every hour, Instar counts for each work queue (feedback sorting, feedback
fixes, maturation fixes, commitments, action items) how many items came in, were finished, left for
other reasons, and remain open, and gives a plain verdict (catching up, holding, falling behind,
shrinking without finishing, unknown) with the reason a queue is behind. A bounded tuner can ask the
feedback sorting service for extra rounds when the sorter itself is the limit (ships off on the fleet,
dry-run on a development agent). `GET /queue-pace`, a Pace card in the console and a pace line on the
maturation board.

## What to Tell Your User

You can now see, for each of my work queues, whether it is shrinking or growing and why. Where the
worker itself is the slow part, it can speed up within existing limits.

## Summary of New Capabilities

Queue pace view (`GET /queue-pace`, console Pace card) and an opt-in triage pace tuner.

## Evidence

On 2026-10-30 no surface compared arrivals with completions for any queue; feedback had ~350 reports/
day arriving and 381 items queued for a fix. Unit, integration and e2e tests cover the verdicts,
crash-safe counting, the tuner's limits and the route.
