---
title: Completion-claim failure ledger and shared-cap repair
slug: completion-claim-failure-ledger
eli16-overview: docs/specs/completion-claim-failure-ledger.eli16.md
---

# Completion-claim failure ledger and shared-cap repair (CMT-1131)

## Problem

The feature maturation review of 2026-10-30 measured the completion-claim verifier failing on 41% of turns since 10-28 (+447 invalid of +1,094 admitted), while its LLM calls errored 0.3%.

Those numbers fit together only if the failed turns never reached a model: 1,094 admitted minus 447 invalid is 647, which matches the call count for that period. The hourly provenance rows show the same thing. Calls start at 00:00 UTC, stop around 06:00 UTC, and do not resume until a later restart.

## Cause

`AgentServer` runs the verifier through the shared `LlmQueue`. That queue has PromiseBeacon's 100-cent daily cap with a 40% interactive reserve. Each verifier call is charged an estimated 0.25 cents, so the background share lasts at most 240 calls a day, and fewer when other callers use it too. After that the queue throws `LLM background lane would breach interactive reserve`.

`ClaimClauseArbiter.arbitrate` catches every error and returns the same shape as a parse failure, so the verifier counts `invalidOutputTurns`. The refused call has no provider run, so `/metrics/features` shows no error. Other background callers on that queue are refused too for the rest of the UTC day.

## Change

1. **Dedicated queue.** The verifier gets its own `LlmQueue` with no interactive reserve. The bound that applies is the existing `enqueueMetered` component budget (300 an hour, 2,000 a day, 10M input tokens, 500 cents). This follows the per-sentinel queue pattern `correctionLlmQueue` already uses.
2. **Typed refusals.** `LlmQueue` throws `LlmQueueAdmissionError` with a code. Messages are unchanged.
3. **Attributed failures.** `arbitrate` returns `failure: { reason, branch, model, framework }` whenever it is not authoritative. Parsing keeps the same accept and reject behavior; each rejection now names its branch.
4. **Per-turn ledger.** `CompletionClaimFailureLedger` appends to `logs/completion-claim-failures.jsonl` and keeps a 30-day rollup in `logs/completion-claim-daily.json`. Rows hold fixed codes and a model name only. Claim text, model output, error messages and model-authored key names are never written. Turns that expire in the admission queue are recorded too.
5. **Observe-only hold.** `isObserveOnly()` is true while `dryRun` is set or while the last 7 complete UTC days do not each have at least 20 turns and a failure rate under 5%. The three route sites that read `dryRun === false` use it instead. The hold only keeps the existing Action-Claim path in charge.
6. **Read surface.** `GET /completion-claim/failures` returns rows, the rollup, the gate and `observeOnly`.

## Acceptance

- A reproduction on a shared queue shows the refusals and names them `lane-reserve` in the ledger; the same load on a dedicated queue reaches the model every turn.
- Every parse branch has a named code, and a test proves no claim text reaches the logs.
- The gate holds at exactly 5%, on a quiet day, on a missing day and on a corrupt rollup.

## Not changed

The 5% target itself is not proven by this change. The ledger measures it from now on, and any remaining failures will show up by reason.

## Rollback

Reverting restores the shared queue and the previous counters. The two new log files are inert.
