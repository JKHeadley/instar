# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The pre-messaging honesty guard now recognizes your agent's other machines as
its own.** A multi-machine instar agent runs on more than one machine, each
exposed at its own subdomain under the operator's tunnel domain (for example the
laptop and the Mac Mini each get a subdomain of the same tunnel domain). The
URL-provenance check — which blocks messages containing made-up-looking links —
previously trusted only the agent's exact own tunnel host, so a legitimate
operation addressing a sibling machine of the same agent was falsely flagged as
an "unfamiliar domain" and blocked.

It now also trusts hosts that share the agent's tunnel parent domain, so sibling
nodes are recognized — while still blocking genuinely fabricated links. Two
guards keep it safe: the parent domain is derived only when the own host has at
least three labels (never trusts a bare public-suffix apex), and the match is a
true DNS-suffix test (a look-alike like echo.dawn-tunnel.dev.evil.com stays
blocked because it actually ends in evil.com). Single-machine agents are
completely unaffected.

## What to Tell Your User

Nothing to configure. If your agent runs across more than one machine, it can
now perform legitimate cross-machine operations (like the multi-machine reply
relay) without its own honesty guard blocking the request — while still catching
invented links. If you only run one machine, nothing changes at all.

## Summary of New Capabilities

- `convergence-check.sh` URL-provenance guard trusts sibling-node tunnel hosts
  (any host under the agent's tunnel parent domain), in addition to the agent's
  own host, Cloudflare quick tunnels, and the static allowlist. Deploys to
  existing agents via the standard `migrateScripts()` template path (the template
  content is the migration — no `PostUpdateMigrator` code change).

## Evidence

- Reproduction (live, 2026-06-01): proving the multi-machine reply relay, the
  command `POST https://echo-mini.dawn-tunnel.dev/telegram/reply/8882` (laptop
  driving the mini's tokenless-standby relay) was blocked by the
  `grounding-before-messaging` hook because its convergence-check URL-provenance
  guard flagged `echo-mini.dawn-tunnel.dev` as unfamiliar — it knew the laptop's
  own host `echo.dawn-tunnel.dev` but not its sibling. The mini's LAN address was
  firewalled, so the tunnel host was the only path, and the proof was blocked.
- Before/after (the guard decision, real shipped template): own host
  `echo.dawn-tunnel.dev` → parent `dawn-tunnel.dev`; sibling
  `echo-mini.dawn-tunnel.dev` BLOCK→PASS (the fix); own host PASS→PASS;
  `totally-fake-host.xyz` BLOCK→BLOCK; look-alike `echo.dawn-tunnel.dev.evil.com`
  BLOCK→BLOCK; arbitrary host with a 2-label apex config BLOCK→BLOCK (apex not
  over-trusted).
- Tests: `tests/unit/convergence-check-sibling-trust.test.ts` (6) execute the
  real shipped `convergence-check.sh`: `bash -n` valid; sibling trusted; own
  unchanged; fabricated blocked; look-alike suffix blocked; 2-label apex not
  over-trusted. 6/6 green; `tsc` clean.
