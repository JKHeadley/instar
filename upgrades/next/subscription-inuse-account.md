<!-- bump: minor -->

## What Changed

Adds a new read-only endpoint `GET /subscription-pool/in-use` and a Subscriptions-dashboard indicator that shows which pool account the agent is **currently running on** — distinct from the per-account `status: active`, which only means "healthy/usable." New `InUseAccountResolver` answers this authoritatively by probing `claude auth status` (the active-account surface the client itself uses) and matching its email to a pool account; the result is cached (60s TTL) with concurrent-probe coalescing and degrades to "unknown" rather than throwing. The dashboard fetches `/in-use` best-effort (its failure cannot blank the accounts list) and renders an "● In use now" badge plus a highlighted card on the active account. Wired as a single shared resolver instance through the server so the cache is honored. Read-only and additive: no change to session launch, account selection, or any mutation path; a zero-account pool answers `{ enabled:false }`.

## What to Tell Your User

Your Subscriptions dashboard now shows, at a glance, which of your accounts the agent is actually using right now — marked with a green "In use now" badge and outline. Before, every account just said "Active," which only meant it was healthy, not that it was the one in use. Now you can tell them apart. This is read-only — it just reports which account is live; it doesn't change anything about how the agent picks accounts.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| See which account the agent is running on | Subscriptions dashboard tab — "● In use now" badge |
| Query the active account | GET /subscription-pool/in-use |
