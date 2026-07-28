# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The pre-message URL provenance check now recognizes the agent's own configured tunnel hostname and Cloudflare quick-tunnel hosts. This fixes a Secret Drop dogfood failure where the agent generated a legitimate one-time collection link, but the convergence check treated the tunnel URL as an unfamiliar fabricated domain. The fix also covers private-view links served over the same tunnel path. Random unfamiliar domains still flag.

## What to Tell Your User

I can now send my own Secret Drop and private-view links through the normal chat path without the pre-message URL check mistaking them for made-up outside links.

## Summary of New Capabilities

| Area | Capability |
| --- | --- |
| Secret Drop | One-time links served on the agent's own tunnel pass the pre-message URL provenance check. |
| Private views | Agent-generated view links on the configured tunnel no longer trip the fabricated-URL guard. |
| Message safety | Random unfamiliar domains still flag, and missing config falls back to the existing conservative behavior. |

## Evidence

- Unit coverage: `tests/unit/convergence-check.test.ts` verifies configured tunnel URLs and Cloudflare quick-tunnel URLs pass, while random fabricated domains still raise URL provenance warnings when config is missing.
