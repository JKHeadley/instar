# Either-window quota pressure — Plain-English Overview

> The one-line version: an account now counts as "at its limit" if EITHER its 5-hour OR its weekly window is nearly full — not just the weekly one.

## The problem in one breath

Each Claude account has two separate limits: a 5-hour rolling one and a weekly one. The swap logic was only really watching the weekly number. So an account that was slammed on its 5-hour limit (say 95%) but fine for the week (40%) looked "fine" — and wouldn't trigger a swap, even though you'd actually be locked out for the next few hours.

## What changed

The "is this account under pressure?" check now looks at whichever window is MORE used — the max of the two. So if either the 5-hour or the weekly is near the threshold (90%), the account counts as under pressure: it won't be picked for new work, and a session on it should move to another account.

## What did NOT change

- The threshold is still 90%, the swap mechanism is unchanged, and automatic swapping still ships off by default.
- If only one window's data is available, it behaves exactly as before.
- Picking which account to drain first (by reset time) already looked at both windows — untouched.

## Proven

Four new tests: 5-hour maxed (weekly low) → at pressure; weekly maxed (5-hour low) → at pressure; both below → not; and selection skips a 5-hour-maxed account in favor of one with room. All scheduler tests stay green; type-check clean.
