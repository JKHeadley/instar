# Upgrade Guide — recommended-services-github-recipe

## What Changed

The fourth recommended-services setup recipe, `github-v1` (`src/recommended/recipes.ts`), available on every agent after its live proof (catalog `setupRecipe: 'github-v1'`). After a yes, the setup session asks whose GitHub account to use, takes a token through one Secret Drop, stores it through the key route, and asks the server to make the backup: `POST /recommended-services/github-state-backup/sync` creates the private repository `instar-<agent>-state` under the token's account if needed, refuses to push to a repository that is not private, and pushes the state folder (`src/recommended/githubBackup.ts`, token in the child environment only). The check passes when GitHub says the repository is private and its head matches this machine; a repository that has gone public fails the check, is never pushed to, and raises one attention item with the fix (`VerifyResult.attention`, `raiseAttention`). The regular check pushes again daily. A switch-off removes the stored token and sets `gitBackup.enabled: false` in the config (spec: `docs/specs/recommended-services.md`, First recipes: GitHub). The confirm page lists copied secret names only for a recipe that copies secrets (`listsCopies`).

## What to Tell Your User

I can now keep a private copy of my memory and settings on GitHub, so I can be brought back if this machine is lost. If you want that, say so and I'll send you the page to say yes with your PIN; the only thing setup asks for is a GitHub token, through one secure link. My secrets are never part of that copy, and I never push to a repository that is public.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| GitHub private-backup recipe (every agent) | The person asks, or the offer list once live; yes on `/dashboard/service-yes?service=github-state-backup` with the PIN |
| Server-made private repository and push | `POST /recommended-services/github-state-backup/sync` from the setup session; pushed daily |
| Public-repository notice | Automatic: one attention item, no push, until the repository is private again |

## Evidence

`tests/unit/recommended-services-github-recipe.test.ts` (check, push, switch-off, brief rules, names), `tests/integration/recommended-services-github.test.ts` (the whole job through the routes, the public-repository notice raised once and cleared on a pass, the daily push, the switch-off turning the config switch off), `tests/e2e/recommended-services-alive.test.ts` (dark on a fleet agent; reachable on a proving agent through the real wiring). Live proof 2026-11-07 on throwaway `recsvc-bw-agent` (real Telegram test group, Echo as the person): ask → explanation + confirm link → yes with PIN → setup topic → one Secret Drop → private repository `EchoOfDawn/instar-recsvc-bw-agent-state` created and pushed, check passed (23:47:13Z) → repository made public: check failed, push refused, one attention item → private again: check passed, no second item → no with switch-off: token gone, `gitBackup.enabled: false`, repository stays, owner told. Evidence: `.instar/lanes/bitwarden-recipe-1107/github-*`.
