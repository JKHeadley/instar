# Side effects: Telegram and email recipes marked live-proven

**Tier 1.** 4 files changed, about 15 lines (catalog, one unit test, two e2e tests). One review pass, one commit attempt expected. Proportionate.

## Summary
`src/recommended/catalog.ts`: the `telegram` and `email` rows change `setupRecipe` from `null` to `telegram-v1` and `email-v1`, with the live-proof citation in a comment. `isServiceAvailable()` is unchanged; it now returns true for both rows on every agent, not only an agent with them in `recommendedServices.provingRecipes`.

## Phase 1: decision point?
Yes, in a narrow sense: availability decides whether the confirm page accepts a yes for the service. This change does not add or alter a gate's logic. It flips data the existing gate reads, on the evidence the gate was designed to wait for (a live proof).

## 1. Over-block
None. The change only widens availability.

## 2. Under-block
A person on an agent with no Telegram and no other way in who switches Telegram off later: the switch-off waits until another route works (the spec's way-in rule, noted as an open design point in the proof result). That is existing behaviour, unchanged here, and it fails safe: the agent keeps its one channel instead of going silent.

## 3. Level-of-abstraction fit
Right layer: the catalog is the single source of what is proven. No parallel switch is added.

## 4. Signal vs authority
No new authority. The person's yes on the confirm page stays the only thing that starts setup; the proactive offer list stays behind `recommendedServices.offers.enabled` (off).

## 5. Interactions
The offer list (when someone turns it on) now includes Telegram and email among available services. The yes-binding text hash (`offerTextHash`) covers only the person-facing text, which is unchanged, so no existing yes is invalidated. Agents that listed these recipes under `provingRecipes` behave the same.

## 6. External surfaces
Visible to users: the dashboard's recommended-services section and the confirm page now show both as available. Setup reaches Telegram (BotFather via the agent's browser) and the chosen email provider only after a yes.

## 7. Multi-machine posture
The catalog is code, identical on every machine of a version. Setup state per service is already handled by the existing recipes (email: lease-holder one voice with a signed mesh forward; Telegram: one polling machine).

## 8. Rollback cost
Revert the two lines (hot-fix release). A person who already set either up keeps a working service; the switch-off routes remain.
