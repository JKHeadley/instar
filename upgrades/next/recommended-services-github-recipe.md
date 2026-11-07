# Upgrade Guide — recommended-services-github-recipe

## What Changed

The fourth recommended-services setup recipe, `github-v1` (`src/recommended/recipes.ts`), dark until its live proof: only an agent listing it under `recommendedServices.provingRecipes` reaches it. After a yes, the setup session asks whose GitHub account to use, takes a token through one Secret Drop, stores it through the key route, and asks the server to make the backup: `POST /recommended-services/github-state-backup/sync` creates the private repository `instar-<agent>-state` under the token's account if needed, refuses to push to a repository that is not private, and pushes the state folder (`src/recommended/githubBackup.ts`, token in the child environment only). The check passes when GitHub says the repository is private and its head matches this machine; a repository that has gone public fails the check, is never pushed to, and raises one attention item with the fix (`VerifyResult.attention`, `raiseAttention`). The regular check pushes again daily. A switch-off removes the stored token and sets `gitBackup.enabled: false` in the config (spec: `docs/specs/recommended-services.md`, First recipes: GitHub). The confirm page lists copied secret names only for a recipe that copies secrets (`listsCopies`).

## What to Tell Your User

Nothing changes for you yet. GitHub private backup is the next service I'm learning to set up: once it's proven on a test agent, you'll be able to say yes and I'll keep a private copy of my memory and settings on GitHub, so I can be brought back if this machine is lost. My secrets are never part of that copy.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| GitHub private-backup recipe (proving agents only) | `recommendedServices.provingRecipes: ["github-v1"]` on a throwaway or development agent |
| Server-made private repository and push | `POST /recommended-services/github-state-backup/sync` from the setup session; pushed daily |
| Public-repository notice | Automatic: one attention item, no push, until the repository is private again |

## Evidence

`tests/unit/recommended-services-github-recipe.test.ts` (check, push, switch-off, brief rules, names), `tests/integration/recommended-services-github.test.ts` (the whole job through the routes, the public-repository notice raised once and cleared on a pass, the daily push, the switch-off turning the config switch off), `tests/e2e/recommended-services-alive.test.ts` (dark on a fleet agent; reachable on a proving agent through the real wiring). Live proof follows on a throwaway agent before the catalog row is marked available.
