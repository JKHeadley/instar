# Upgrade Guide — recommended-services-offers

## What Changed

The first list of recommended services (spec: `docs/specs/recommended-services.md`, Offers), behind `recommendedServices.offers.enabled` (default off). When the switch is on, this machine holds the lease, a first result has been delivered (`state/offer-prerequisites/first-result.json`), the owner's migration flag is set, and an owner resolves, the regular setup check sends one Telegram message to the lifeline topic listing every available service with no choice, no legacy decline, no earlier offer, and not already in use on this machine (`verify` passes → `inUse` in the setup state, a fact, never a choice). Each row: benefit, what leaves, cost, account, backup, the confirm link; a `No to <name>` button per row (S-class tap, 10 an hour, records `no` with origin `first-offer` and `shutdown: none`); a `Yes to <name>` button only for an address service when there is no address (owner-only, P-class; records the yes and starts setup exactly as the confirm page does). Offer rows live in the signed, replicated ledger (`type: 'offer'`, `pending` before the send, `offered` from the platform's message id); a pending row with no delivery is resent after an hour and released after a week; at most one list a week. `GET /recommended-services` reports `offersLive` and per row `offered` and `inUse`; the dashboard row says "Offered, not answered" / "Already in use here". The CLAUDE.md section moves to its v3 wording in place.

## What to Tell Your User

Once this is switched on for me, I'll tell you once, in one message, which outside services would help me do my job, with what each costs and what leaves your machine. You say yes with your PIN on the page I link, or press No under the message. If you don't answer, nothing happens and the list stays on my dashboard. I never ask twice without a real reason.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| The first list | `recommendedServices.offers.enabled: true` in the config, then the next setup check (five minutes) sends it once the preconditions hold |
| Offered rows | `GET /recommended-services` → `offersLive`, and `offered` / `inUse` per row |
| No / Yes buttons | Under the list in Telegram; No for anyone in the conversation, Yes for the owner on an address service |

## Evidence

`tests/unit/recommended-services-offers.test.ts` (offer rows, candidates, words and buttons, taps), `tests/integration/recommended-services-offers.test.ts` (sent once, pending → offered from the message id, resumed after a refused send, held by each precondition, decided and in-use rows left out, the taps' rules, the page yes still works), `tests/unit/recommended-services-wiring.test.ts` (server and adapter plumbing), `tests/unit/PostUpdateMigrator-recommendedServicesSection.test.ts` (v2 → v3 wording once). Live proof on a throwaway agent before the switch goes on for the development agent.
