# Side-Effects Review — either-window quota pressure (QuotaAwareScheduler)

## Scope of change

- `src/core/QuotaAwareScheduler.ts` — `bindingUtilization()` now returns the MAX
  utilization across the account's known windows (5-hour AND weekly), instead of
  preferring the weekly window (and only falling back to 5-hour when weekly was
  absent). One function body; the comment is updated. Tests added.

## Why (live-test finding, 2026-06-07)

The operator asked whether the swap trigger considers BOTH the 5-hour and weekly
limits. It did not: `bindingUtilization` returned the weekly utilization if present,
so an account maxed on its 5-HOUR window (e.g. 95%) but low for the week (40%) read
as 40% and was NOT flagged at pressure — even though the 5-hour limit blocks you
independently for the next hours. The correct rule is "either window crosses the
threshold." Taking the max across windows makes pressure, selection-eligibility, and
the use-before-reset headroom all key on the most-constrained window.

## Behavior change

`accountAtPressure` (>= threshold), `selectAccount` eligibility (< threshold), and
`scoreAccount` headroom (100 - it) all flow through `bindingUtilization`, so all three
now use either-window semantics. The change only matters when BOTH windows are present
AND the 5-hour is higher than the weekly — exactly the previously-missed case. When only
one window is present, behavior is identical to before. Reset-timing (`soonestResetMs`)
already scanned both windows; unchanged.

## Authority / autonomy

No new authority. Auto-swap still ships dark behind `subscriptionPool.autoSwapOnRateLimit`.
This corrects WHEN an account is considered at-pressure; it does not change the swap
mechanism or make anything fire on its own that didn't before (other than now correctly
recognizing 5-hour-window pressure).

## Framework generality

Provider-agnostic in shape: `bindingUtilization` operates on whatever windows an
`AccountQuotaSnapshot` carries (5-hour / weekly today). Any provider whose snapshot
exposes multiple windows gets correct either-window pressure for free.

## Failure modes considered

- Only one window present → max of one value = that value (identical to before).
- No quota yet → 0 (selectable), unchanged.
- Both windows present, 5-hour higher → NOW flagged at pressure (the fix).

## Migration / parity

Pure in-memory logic on data the QuotaPoller already writes — no migration, no config,
no stored-shape change. Ships via dist.
