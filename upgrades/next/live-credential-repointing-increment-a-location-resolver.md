# Upgrade Guide — Live credential re-pointing (Increment A, Step 6a)

<!-- bump: patch -->

## What Changed

Step 6a — `CredentialLocationResolver`, the single read-side chokepoint the ~12 consumers that ask "which slot is this account's login in?" will route through, shipping **dark** with no consumer yet (zero runtime behavior change). The load-bearing property is no-op-while-dark: it only consults the location ledger when the feature is enabled AND the ledger is seeded AND not corrupt — otherwise every consumer keeps exactly today's behavior (the account's enrollment home). So re-routing each consumer through it adds nothing until the feature is deliberately turned on.

## What to Tell Your User

Nothing changes for you — internal plumbing for the upcoming restartless rebalancing, shipping switched off. This is the shared piece that will let every part of the system agree on where each account's login currently lives once logins can move between slots; until the feature is enabled it just returns the same answer everything uses today.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Single source of truth for credential location | Automatic (internal) — consumers route through it; a no-op until the feature is enabled |

## Evidence

- 7 new unit tests (`credential-location-resolver.test.ts`): disabled/absent-config/unseeded/unknown-mode all return today's behavior; enabled+seeded resolves the ledger slot/tenant; account-not-in-ledger falls back to the enrollment home; the config is read live (a flip is honored without reconstructing the resolver).
- `npx tsc --noEmit` clean; the credential-write lint clean.
