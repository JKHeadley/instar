<!-- bump: patch -->

## What Changed

Gave the cutover-readiness live-comparison trigger a realistic time budget. A real
comparison downloads the full live dataset and takes a few minutes; the default
30-second request limit cut off every response mid-run, and a late failure then
crashed the response handling with no record of what happened. The trigger now has
a six-minute budget, and whatever the outcome — recorded or failed — it is always
written to the server log, even if the caller's connection already timed out.

## What to Tell Your User

Nothing changes day to day. If your agent runs live data comparisons for a
migration, those checks now finish reliably instead of getting cut off, and their
results always show up in the logs.

## Summary of New Capabilities

- The live parity-comparison trigger completes within a realistic six-minute
  budget instead of being cut off at thirty seconds.
- Comparison outcomes are always logged server-side, even when the requester's
  connection timed out first.
- Maturity: stable; no other route's timing changes.
