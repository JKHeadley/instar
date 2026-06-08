# Either-window quota pressure (Subscription pool)

<!-- bump: patch -->

## What Changed

The quota-aware scheduler's "at pressure" check now considers BOTH per-account
windows: an account counts as at its limit when EITHER the 5-hour OR the weekly
utilization crosses the threshold (90%), instead of keying only on the weekly
window. `bindingUtilization` now returns the max across the account's known
windows, so pressure, selection-eligibility, and use-before-reset headroom all
key on the most-constrained window. Fixes a gap where an account maxed on its
5-hour limit but low for the week was wrongly treated as having room. Threshold,
swap mechanism, and dark-by-default auto-swap are unchanged.

## What to Tell Your User

When I balance across your subscription accounts, I now treat an account as "full"
if EITHER its 5-hour or its weekly limit is nearly maxed — not just the weekly one.
So a session won't get stuck on an account that's hit its short-term limit even if
the week still has room.

## Summary of New Capabilities

- **Either-window pressure** — an account is "at its limit" when the 5-hour OR the
  weekly window crosses the threshold (the 5-hour limit blocks independently).
- No behavior change when only one window is known; auto-swap stays opt-in.
