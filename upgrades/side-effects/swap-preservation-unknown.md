# Side-effects review: an unreported conversation carry-over is logged as unknown

## What changes
In `QuotaAwareScheduler.onQuotaPressure`, the success log after an account swap had two branches: `conversationPreserved === false` (warn: not carried over), and everything else (log: "conversation preserved via --resume"). A legacy boolean `true` result, or an object without the field, therefore logged confirmed preservation without any evidence. Now `undefined` gets its own line: "whether the earlier conversation carried over is unknown (not reported)". `true` still logs preserved, and `false` still warns.

## Behavior
Only the log text for the undefined case changes. The swap result (`swapped`, `toAccountId`, `reason`), anti-thrash accounting and control flow are unchanged.

## Risks considered
- **Log readers:** anything grepping for "conversation preserved" now stops matching the unproven case. That is the intent, since that match was a false claim.
- **Rollback:** revert this commit.

## Tests
`tests/unit/swap-continuity-verified-recovery.test.ts` adds three cases: a legacy boolean result and an object without the field both log unknown and never "conversation preserved", and an explicit `conversationPreserved: true` still logs preserved. All 91 tests across the six QuotaAwareScheduler test files pass, and the type check is clean.
