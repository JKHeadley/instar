<!-- bump: patch -->

## What Changed

Recommended services gains its second setup recipe, for Tailscale (`tailscale-v1` in `src/recommended/recipes.ts`). It stays dark: like Jev's, it only runs on a throwaway or development agent that lists it under `recommendedServices.provingRecipes`, and offers stay off everywhere (`offersLive: false`).

The recipe's brief has the setup session check whether Tailscale is installed and install it without administrator rights where it can, take care of the Linux operator step, start Tailscale's sign-in and send the person its one-tap link, then call the check. It never uses an auth key, a stored credential or a browser login of its own, and never signs out or moves a machine that is already on a tailnet. If it can't finish, the agent stays reachable through its backup (Cloudflare, the local network or messaging).

The check reads `tailscale status --json` (the program on PATH first, then the Mac app and the usual install folders). It passes only when the machine is signed in, has a private address and is online, and its words never include an address, device or account name. A hung Tailscale answers "unknown", so a yes starts nothing until it can be read. A recipe can now declare that it keeps no secret, and the key route refuses one for it.

The outbound link check now lets Tailscale's sign-in host (`login.tailscale.com`, that exact host only) through. In the live run it refused the sign-in link, the recipe's one step for the person, even after the link came from tool output.

## What to Tell Your User

Nothing changes for you yet. Your agent is learning to set up Tailscale for you, so that later you can reach it from your own devices with one tap on a sign-in link. It only runs on test agents until it has been proven.

## Summary of New Capabilities

- A Tailscale setup recipe for recommended services, available only on proving agents.
- The Tailscale check: signed in, with a private address, and online, read from Tailscale itself.
- A recipe with no secret makes the key route refuse any key for that service.
- Tailscale sign-in links are no longer refused by the outbound link check.

## Evidence

Unit tests on the check (including real captured `tailscale status --json` output, signed in and never signed in), the program reader, and the brief; route tests for start, already-on-a-tailnet, hung Tailscale, verify fail then pass, and the refused key; link-check tests for the sign-in host and look-alikes. The existing recommended-services suites pass. Live run on a throwaway agent through the real Telegram test group: see `.instar/lanes/tailscale-recipe-1106-REPORT.md` on the development agent.
