# Upgrade Guide — recommended-services-bitwarden-recipe

## What Changed

The third recommended-services setup recipe, `bitwarden-v1` (`src/recommended/recipes.ts`), proven live on a test agent on 2026-11-07 and therefore available on every agent (`setupRecipe: 'bitwarden-v1'` in the catalog). After a yes, the setup session installs the Bitwarden CLI if needed, logs in to the person's account or one of the agent's own, stores the master password through the key route, and asks the server to write the copy: `POST /recommended-services/:id/sync` copies every stored secret, by name, as Secure Notes into the folder `instar/<agent>` and returns names only. The confirm page lists what would be copied (`copies`). The regular check refreshes a working copy daily. A switch-off removes the stored password and signs out only a login setup made. `BitwardenProvider.unlock/login` now pass the master password through `--passwordenv` and the child environment, never as an argument (spec: `docs/specs/recommended-services.md`, First recipes: Bitwarden).

## What to Tell Your User

You can now say yes to Bitwarden on my Services list, and I'll keep a copy of my own secrets in a folder of mine in your Bitwarden (or in an account of my own), so they survive losing this machine. I ask you once for the login through a secure form, never in chat, and I refresh the copy daily. If you later say no and tick "switch it off", I forget the password here and sign out; the copies in your folder stay. If I already use Bitwarden here, your master password now never appears where other programs could read it.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Say yes to Bitwarden on any agent | Dashboard → Services → "Yes or no", with your PIN |
| Server-written copy of the agent's secrets | `POST /recommended-services/bitwarden/sync` from the setup session; refreshed daily |
| Master password kept off the command line | Automatic, in `BitwardenProvider` |

## Evidence

`tests/unit/recommended-services-bitwarden-recipe.test.ts` (check, copy, switch-off, brief rules, what gets copied), `tests/unit/bitwarden-provider.test.ts` (password in the environment only; logout), `tests/integration/recommended-services-bitwarden.test.ts` (the whole job through the routes, the daily refresh, both switch-off sides), `tests/e2e/recommended-services-alive.test.ts` (live on a plain agent through the real wiring; the copy route stops at the missing yes). Live proof 2026-11-07 on a throwaway agent in the real Telegram test group: ask → confirm page → yes with PIN → setup topic → one Secret Drop → login → stored password → server-written copy → check passed → the agent said it works; the empty first copy it reported led to the config-held-secrets fix (five items on the next copy, confirmed in the vault); a no with "switch it off" removed the password, signed the machine out and left the copies. Evidence: `.instar/lanes/bitwarden-recipe-1107/` on the development agent's Mac Mini.
