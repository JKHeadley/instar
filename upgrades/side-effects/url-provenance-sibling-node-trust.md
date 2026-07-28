# Side effects — URL-provenance sibling-node trust

## What changes at runtime

The pre-messaging convergence check's URL-provenance guard now additionally
trusts URL hosts that share the agent's tunnel **parent** domain (sibling nodes
of the same multi-machine agent), in addition to the agent's exact own tunnel
host, Cloudflare quick tunnels, and the static allowlist it already trusted.

## Who is affected

- **Single-machine agents:** NO behavior change. They address no sibling nodes;
  the parent-domain trust simply never matches a host they'd ever message. A
  fabricated unfamiliar URL is still flagged exactly as before.
- **Multi-machine agents:** a message that legitimately references a sibling
  node (e.g. the laptop addressing the mini's tunnel host to drive the
  multi-machine reply relay) is no longer falsely flagged as an "unfamiliar
  domain."

## Blast radius

- Single file: `src/templates/scripts/convergence-check.sh`, the URL-provenance
  block only. Re-deployed to `.instar/scripts/convergence-check.sh` via the
  existing `migrateScripts()` template-load path (no PostUpdateMigrator code
  change; the template content IS the migration).
- No config keys added/changed. No new dependency. The check still runs as the
  same heuristic gate behind the `grounding-before-messaging` hook.

## Failure modes considered

- **Over-trust of a public-suffix apex:** prevented — the parent is derived only
  when the own tunnel host has ≥3 DNS labels, so a 2-label apex config yields no
  parent (verified by test).
- **Look-alike suffix attack** (`echo.dawn-tunnel.dev.evil.com`): blocked — the
  match is a true DNS-suffix test (`${URL_HOST%.$PARENT}`), so a host that merely
  contains the parent mid-string but ends elsewhere is not trusted (verified by
  test).
- **Missing/empty tunnel config:** no parent derived → unchanged behavior.

## Not touched

- The pre-existing inline fallback `PostUpdateMigrator.getConvergenceCheckInline()`
  is intentionally NOT modified here. In practice `loadTemplate()` always returns
  the template file, so the inline path is dead code; it additionally has a
  separate, pre-existing bash syntax error on `main` (independent of this change)
  and entangling a fix would muddy this diff. Flagged as a separate latent issue.
