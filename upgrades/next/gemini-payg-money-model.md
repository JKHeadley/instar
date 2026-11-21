# The spending limits for the Gemini pay-per-use lane

<!-- bump: patch -->

## What Changed

This release builds the rules Instar will use to spend on Gemini by the token. Nothing can spend yet: the paid Gemini door is still off and has no checked price, so no paid call is possible.

- **Monthly limits.** A pay-per-use key can now have a monthly limit as well as a daily one, counted in a chosen time zone. The Gemini key's default is $50 a month and $10 a day, on Pacific time. Each charge stays in the day and month it was made in, even if the zone later changes.
- **Per-door rules.** The paid door now has its own rule record:
  - the most one call may cost ($2.50);
  - a ceiling on uncertain charges;
  - a share of the month for second opinions (40%, $4 a day);
  - one paid pass per review round;
  - which kinds of callers may use the door.
  Adding a caller or raising a share needs the owner's PIN. Lowering a limit or removing a caller is instant.
- **Honest charges when a call goes wrong.** For the Gemini door, a call that fails after it was sent, or never reports back, counts at its full reserved cost, because Google may have billed it. If the real bill later arrives lower, the limit does not give the money back. If it arrives higher, only the difference is added.
- **Clear reasons when a call is refused.** There are 13 new reasons, such as "this caller is not allowed", "the proof check has not passed yet", "too big for the checked price" and "other calls are still finishing, try again in a moment". Each has its own status code and plain message, and keeps them when passed between machines.
- **Repeated requests are safe.** Resending a call with the same id returns the original call instead of paying again, even after a restart.
- **Prices must be checked.** A price not yet checked on Google's page counts as out of date, and the Gemini door refuses a request larger than the checked price covers.
- **No paid models in the default routing.** Background routing now uses only subscription models by default. A paid model is used only where it is explicitly allowed.

## What to Tell Your User

- **Spending limits ready for Gemini**: "I've built the spending limits for the pay-per-use Gemini lane: $50 a month and $10 a day on Pacific time, with a cap on how much any one call can cost. Nothing is spending yet. The lane stays off until you approve it and its price is checked."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Monthly caps with a period time zone | The caps view on the Spend tab shows the monthly cap, the zone and this month's spend |
| Per-door paid-call policy | Set through the owner's PIN plan; lowering is instant |

## Evidence

- Unit: `tests/unit/gemini-payg-money-model.test.ts` (69 tests). Covers monthly-only validation, LA day/month across DST and month boundaries, strict limits on month, day and E2 share, provisional expiry for gemini-api with $0 for other doors, max(provisional, actual), the provisional ceiling under concurrency, reserves-outstanding versus cap-exceeded, caller/E3/release-state order, the admission race under the lock, dedupe first across a restart, callid-conflict, E1 slots, tiers with reversed manifest order, settle at the reserved point, refusal status and wire round trip, reduce-only mutators, the zone fixed while live, no metered door in the default chains, and pre-change caps/ledger loads.
- Updated: `tests/unit/metered-spend-gate.test.ts`, `routing-spend-view.test.ts`, `nature-routing-map.test.ts`, `tests/integration/routing-spend-routes.test.ts` (monthly caps-adjust render and commit), `tests/e2e/routing-spend-lifecycle.test.ts`.
