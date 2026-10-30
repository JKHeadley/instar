# Completion-claim failure ledger

## What Changed

The completion-claim verifier's 41% failure rate came from the shared LLM spend cap, not from bad model output. Each call was charged an estimated 0.25 cents against the shared queue's background share, which ran out each day at about 06:00 UTC; later calls were refused before reaching a model and were counted as invalid output. The verifier now has its own queue, bounded by its existing component budget. Refusals are typed, every failed turn is recorded with a reason code, failed branch and model (never claim text) at `GET /completion-claim/failures`, and the verifier stays observe-only until failures are under 5% on each of the last 7 complete days, even with `dryRun: false`.

## What to Tell Your User

Instar's checker that compares what an agent said it did against what it actually did was being cut off for much of each day because it shared a small spending allowance with other background features. It now has its own allowance, so it no longer uses up theirs, and it keeps a record of why any check fails, without storing what the message said. It stays in watch-only mode until it has run reliably for a week.

## Summary of New Capabilities

| Capability | How to use it |
|---|---|
| Per-turn failure record for the completion-claim checker | Ask your agent why the checker failed |

## Evidence

Reproduced in `tests/unit/completion-claim-failure-ledger.test.ts`: 300 turns on a shared-cap queue reach the model 240 times and record 60 `lane-reserve` failures; the same 300 turns on a dedicated queue all reach the model. In production, 1,094 admitted turns minus 447 invalid equals the 647 model calls for that period, and calls stop around 06:00 UTC each day until a restart.
