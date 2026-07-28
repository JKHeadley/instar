---
title: Convergence Check Own Tunnel URL Allowlist
review-convergence: 2026-05-29T10:49:00Z
approved: true
eli16-overview: convergence-check-own-tunnel-url.eli16.md
---

# Convergence Check Own Tunnel URL Allowlist

## Problem

The pre-message convergence check is supposed to catch fabricated URLs before they reach a user. That is valuable: agents can invent plausible-looking domains when reporting a deployment or sharing a resource. But the same heuristic was blocking legitimate links the agent generated itself, including Secret Drop collection links and private-view links served over the agent's tunnel.

The root cause is the URL provenance allowlist. It trusts localhost and several well-known public domains, but it did not narrowly trust the agent's own configured tunnel hostname at runtime.

## Proposed Change

Update the convergence-check script template so URL provenance accepts:

- localhost and loopback, as before;
- the agent's own configured tunnel hostname from `.instar/config.json` at runtime;
- Cloudflare quick-tunnel hosts ending in `trycloudflare.com`.

If the config file is missing, malformed, unavailable, or has no tunnel hostname, the script falls back to the existing static allowlist and continues running. A random unfamiliar domain must still be reported.

## Acceptance Criteria

- A URL on the configured tunnel hostname passes.
- A URL on a Cloudflare quick-tunnel host passes.
- A random fabricated domain still raises `URL_PROVENANCE`.
- Missing config does not crash the script and does not accidentally permit random domains.
- The change ships through the PostUpdateMigrator template source so both new installs and migrated agents receive it.

## Decision Points

This modifies the pre-message URL provenance gate. The decision remains deterministic and narrow: it classifies URL hosts as familiar or unfamiliar. No outbound tone-gate behavior changes in this PR.

## Rollback

Rollback is a normal code revert. If the allowlist is too permissive, reverting restores the prior stricter URL provenance behavior. No persistent state or data migration is involved.
