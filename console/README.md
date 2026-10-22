# console/ — the rebuilt operator console (work in progress)

A from-scratch rebuild of the operator dashboard. **Not shipped, and structurally
unshippable** until someone deliberately changes that.

## Why this is a top-level directory and not `dashboard/console/`

`package.json` → `files` is an explicit allowlist. `dashboard` is on it, so anything
placed under `dashboard/` ships to every agent on the next update. `console` is not on
it, so nothing here reaches any install.

Verified, not assumed — `npm pack --dry-run` lists **15** `dashboard/` entries and
**0** `console/` entries.

This also keeps the rebuild off `dashboard/index.html`, which took 22 commits from 3
authors in the last 90 days and has open PRs against it. A wholesale rewrite of that
file would conflict on contact and rot on a long-lived branch. Building beside it means
this can merge to `main` early and often while shipping nothing.

## Going live, when it is ready

A deliberate two-part change, both of which are reviewable on their own:

1. add `"console"` to `files` in `package.json`
2. point the `/dashboard` route at it (`AgentServer.resolveDashboardDir`)

Until both happen, the running dashboard is untouched.

## Reviewing it

Served locally during development and exposed read-only over this machine's Tailscale
Funnel. Mock data throughout — no live wiring yet.

## Design basis

Palette and type come from the two existing Instar surfaces rather than invention:
`instar.sh` (ground `#0a0e17`, teal ramp `#4ba8aa`→`#a7e0e1`, slate neutrals) and the
current dashboard (`#4ade80`, kept here for `live` — the one colour both themes share).
Dark is unconditional, matching the current dashboard, which has no light mode at all;
light is an explicit opt-in only.
