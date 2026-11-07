# Upgrade Guide — recommended-services-bitwarden-recipe

## What Changed

The third recommended-services setup recipe, `bitwarden-v1` (`src/recommended/recipes.ts`), dark until its live proof: only an agent listing it under `recommendedServices.provingRecipes` reaches it. After a yes, the setup session installs the Bitwarden CLI if needed, logs in to the person's account or one of the agent's own, stores the master password through the key route, and asks the server to write the copy: `POST /recommended-services/:id/sync` copies every stored secret, by name, as Secure Notes into the folder `instar/<agent>` and returns names only. The confirm page lists what would be copied (`copies`). The regular check refreshes a working copy daily. A switch-off removes the stored password and signs out only a login setup made. `BitwardenProvider.unlock/login` now pass the master password through `--passwordenv` and the child environment, never as an argument (spec: `docs/specs/recommended-services.md`, First recipes: Bitwarden).

## What to Tell Your User

Nothing changes for you yet. Bitwarden is the next service I'm learning to set up: once it's proven on a test agent, you'll be able to say yes and I'll keep a copy of my own secrets in a Bitwarden folder, so they survive losing this machine. If I already use Bitwarden here, your master password now never appears where other programs could read it.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Bitwarden setup recipe (proving agents only) | `recommendedServices.provingRecipes: ["bitwarden-v1"]` on a throwaway or development agent |
| Server-written copy of the agent's secrets | `POST /recommended-services/bitwarden/sync` from the setup session; refreshed daily |
| Master password kept off the command line | Automatic, in `BitwardenProvider` |

## Evidence

`tests/unit/recommended-services-bitwarden-recipe.test.ts` (check, copy, switch-off, brief rules, what gets copied), `tests/unit/bitwarden-provider.test.ts` (password in the environment only; logout), `tests/integration/recommended-services-bitwarden.test.ts` (the whole job through the routes, the daily refresh, both switch-off sides), `tests/e2e/recommended-services-alive.test.ts` (dark on a fleet agent; reachable on a proving agent through the real wiring). Live proof follows on a throwaway agent before the catalog row is marked available.
