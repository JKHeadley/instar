## What Changed

- **An agent with a single subscription can now repair its own expired sign-in.** The repair's two model calls (the step chooser and the page reader) normally run on the agent's own subscription, which on a one-subscription agent is the very login that died, and on a Mac there is no other account to run the helper session on. So the repair always stopped and waited for the operator. Now, if the operator places an Anthropic API key in the vault under the name `relogin_last_resort_anthropic_api_key`, a lightweight model over that key answers those calls when the shared model fails, and a repair with no other healthy account runs the server-side browser path instead of stopping. Spend is capped at 60 calls per repair and 300 per day; nothing else reads that key, and `ANTHROPIC_API_KEY` is never read.
- **Two accounts, any providers, pinned by test.** A Claude repair can run its helper on a Codex account and a Codex repair on a Claude account; the helper is never the account being repaired. This already worked; the tests now guarantee it.
- `GET /subscription-relogin` reports the last-resort model's state (available, model, calls today, caps), never the key.

## What to Tell Your User

If you only have one Claude or Codex subscription and it signs out, I can now sign it back in myself instead of waiting for you, as long as you have given me a small API key for that one purpose. With two subscriptions I use the other one to fix the first, whichever provider each is.

## Evidence

- Operator request in the subscription-management topic on 2026-10-22, after the auto-login fix merged earlier that day.
- New tests: the single-account case drives the server-side browser path to verified success when the key is present and waits for the operator exactly as before when it is not; a healthy spare account never uses the key; the cross-provider helper is chosen in both directions; the key never appears in status or errors; caps per drive and per day hold and reset correctly.

## Summary of New Capabilities

- Last-resort sign-in model for single-subscription agents, opt-in by placing a key under a repair-specific vault name; configurable under `subscriptionPool.assistedRelogin.lastResort`.
