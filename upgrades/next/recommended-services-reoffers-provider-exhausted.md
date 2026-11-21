<!-- bump: patch -->
## What Changed

Recommended services re-offers, slice E: the `provider-exhausted` problem, and carrying out its yes with no AI model.

- `everyDoorDown` over the subscription pool (a door the pool doesn't know is unknown, never down), sampled on each regular check; two 30-minute outages of every door within 7 days re-offer a second AI subscription.
- A yes to the second subscription while every door is down runs fixed steps with no setup session: install Codex if needed, start its one-tap device-code sign-in, send the link and code the way offers are sent, wait up to 15 minutes, switch it on, then the recipe's own check. Claude's paste-back sign-in is not attempted without a model.
- With no address for the yes page, the re-offer waits, and once per problem (while Tailscale is unanswered) the owner gets Tailscale with an owner-only Yes button. A Tailscale yes while every door is down is also fixed steps: Homebrew install and service on a Mac, `tailscale up`, the person's own tap on the printed link (never a key).
- Off behind `recommendedServices.reoffers.enabled`.

## What to Tell Your User

Nothing changes yet (off by default). When it's on, if every AI subscription the agent uses runs out twice in a week, it asks about adding a second one, and if you say yes while they're all still out, it sets it up step by step without needing to think: you just tap the sign-in link it sends.

## Summary of New Capabilities

- `provider-exhausted` re-offer source; setup with no model for the second AI subscription and for Tailscale (`src/recommended/noModelSetup.ts`). No new routes.

## Evidence

- Unit: `tests/unit/recommended-services-no-model-setup.test.ts` (predicate, episodes, every runner branch for both runners). Integration: re-offers (episodes, held without address, address-first with owner-only Yes, a no on Tailscale) and the real confirm page with every door down. E2E: the regular check reads a subscription pool and starts counting.
