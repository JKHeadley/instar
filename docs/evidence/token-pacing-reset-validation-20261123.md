# Quota Forecast Comparison With Recorded Resets

Recorded reset comparisons now exist for both Claude and Codex. This is a small retrospective sample, with misses outside the forecast ranges. It supports showing the evidence in the read-only dashboard; it does not establish reliable automatic steering or authorize the parked assessment trial.

## Evidence And Method

The authenticated pool response was generated at **2026-11-24 00:09:17.089 UTC**. Studio and Laptop answered; three other configured machine sources were unavailable (one omitted by the fan-out cap, two exceeded the deadline). This is incomplete fleet coverage.

The backend replays each completed cycle using only readings whose `polledAt` is at or before **24 hours before reset**. The comparison uses the last accepted cycle-end reading as its recorded actual. It is not a forecast saved when originally issued, nor an independent re-fetch of the provider's final bill or allowance. The replay distinguishes scored, no-forecast, censored, and unavailable history. An unscored cycle is not a zero-error prediction.

Source: `src/monitoring/quotaPacing.ts`, `calibrate()`. The private input and identity mapping remain in the agent's recovery evidence. Input SHA-256:

`2d515d71d14b41b605fdcc72047b71133d788b2143d45d115b30d0d986651bf7`

Account labels below are anonymous and stable within this report. Usage and errors are percentage points of the named allowance. Error equals recorded actual minus the central forecast. Ranges are the backend's raw scenario bounds, not calibrated confidence intervals; bounds above 100 remain visible here.

## Weekly Allowance

| Account | Reset (UTC) | Central | Raw range | Recorded actual | Error | Position |
| --- | --- | ---: | --- | ---: | ---: | --- |
| Claude A | Nov 20 19:00 | 100 | 100–100 | 100 | 0 | Inside |
| Claude B | Nov 21 21:00 | 89.7 | 86.9–105.6 | 90 | +0.3 | Inside |
| Claude C | Nov 21 16:00 | 82 | 82–89.2 | 96 | +14 | Above |
| Claude D | Nov 22 11:00 | 100 | 100–100 | 100 | 0 | Inside |
| Codex A | Nov 21 23:50 | 86.8 | 86.8–91.5 | 92 | +5.2 | Above |

Dates are in 2026 and rounded to the nearest minute. Claude has four scored cycles, with mean absolute error **3.58 points**; three actuals are inside the ranges and one is above. Two forecasts already at 100 contribute zero error, so they provide limited evidence about predicting future increases. Claude also has two no-forecast cycles, one censored cycle, and two accounts without a recorded completed cycle.

Codex has only **one scored cycle**, with absolute error **5.2 points**, above its range. Three other cycles have no forecast, and one account has no completed cycle. The recorded 92 leaves eight points unused in that historical cycle; it does not demonstrate that current routing consumes all available allowance.

## Fable Allowance (Separate)

Fable is a separate Claude allowance. Its errors must not be pooled with weekly errors or added to weekly utilization.

| Account | Central | Raw range | Recorded actual | Error | Position |
| --- | ---: | --- | ---: | ---: | --- |
| Claude A | 28 | 28–28 | 28 | 0 | Inside |
| Claude B | 94.2 | 90.9–105.1 | 88 | −6.2 | Below |
| Claude C | 40 | 40–50 | 43 | +3 | Inside |
| Claude D | 28 | 28–28 | 28 | 0 | Inside |

These resets correspond to the same account/date rows above. Four scored Fable cycles have mean absolute error **2.30 points**: three inside, one below. Two further cycles have no forecast, one is censored, and two accounts have no completed cycle.

## Validation And Remaining Work

The existing calibration replay checks passed: **9 tests passed**, with 41 unrelated tests skipped by the filter (`npx vitest run tests/unit/quota-pacing.test.ts -t 'calibration replay'`). They cover the replay method, not the authenticity of a provider's final allowance. A separate calculation checked all exposed scored errors against actual minus central within 0.11 points to accommodate displayed rounding, then recomputed the aggregates above.

This report changes no runtime code, account, job, scheduler, routing, approval, or trial setting. It does not claim the proposed dashboard is merged or installed. Keep incomplete source coverage, unscored cycles, and out-of-range outcomes visible. Collect more completed resets, especially Codex, and retain predictions prospectively before using accuracy as evidence for automatic control. Existing project-card approval and dashboard deployment requirements remain open.
