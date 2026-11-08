# Upgrade Guide — recommended-services-available

## What Changed

Tailscale and Jev, the two recommended services whose setup recipes were proven live on a test agent (2026-11-05 and 2026-11-07, topic 135786), are now available on every agent: `GET /recommended-services` shows `available: true` for them and the dashboard's Services list offers "Yes or no". Two pieces the spec required before a real person could be offered this ship with it: a confirmed no can also switch a working service off on this machine (`shutdown: authorized`, carried out by the recipe: Jev removes its key, Tailscale signs out only a machine its own setup signed in, and the switch-off waits while the service may be the person's only way in), and a yes is refused with `cannot-reach-you` on a machine that can't message the person, without spending the page. The CLAUDE.md section and the capability description say what is available and that the agent still offers nothing on its own. Spec: `docs/specs/recommended-services.md`.

## What to Tell Your User

On my Services list you can now say yes to Tailscale or Jev, and I'll set it up myself, coming back to you only for a decision or a credential. If you say no to one that's already working, you can tick a box to have me switch it off on that machine too; otherwise it stays on. I don't bring these up on my own yet.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Say yes or no to Tailscale or Jev on any agent | Dashboard → Services → "Yes or no", with your PIN |
| Switch a working service off with a no | Tick "Also switch it off on this machine" on the same page |
| A yes waits where the agent can't talk to you | Automatic; the page says so and works again once it can |

## Evidence

`tests/unit/recommended-services-catalog.test.ts` pins the available list to exactly Tailscale and Jev. `tests/unit/recommended-services-stop.test.ts` covers both recipes' switch-off on real captured Tailscale status, both sides. `tests/integration/recommended-services-setup.test.ts` covers the reach check (yes refused and later taken on the same page, restarts waiting), the switch-off through the page and the plain route, the strand hold finishing on the regular check, and an authorized no from another machine. `tests/e2e/recommended-services-alive.test.ts` runs the production wiring with the two available and the other seven refused. Live proofs of the two recipes: `.instar/lanes/tailscale-recipe-1106-REPORT.md` on the development agent's Studio.
