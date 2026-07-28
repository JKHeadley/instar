# Side-effects review — claude.com in the URL-provenance allowlist

## Change

Adds `claude.com` to the `url_provenance` allowlist of the pre-messaging
convergence check, in BOTH copies that must stay in sync:
- `src/templates/scripts/convergence-check.sh` (the primary script, read at runtime)
- `src/core/PostUpdateMigrator.ts` → `getConvergenceCheckInline()` (the fallback
  emitted only when the template file can't be found)

It sits next to the already-present `claude.ai` and `anthropic.com` entries.

## Why

The Claude subscription OAuth login link lives on `claude.com` (Anthropic
consolidated the sign-in surface there; `claude.ai` is the sibling already on the
list). During live enrollment testing (topic 20905) the grounding-before-messaging
hook false-flagged the login link as `URL_PROVENANCE` (a possibly-fabricated
domain), which forced wrapping every OAuth link in a private view before it could
be sent to the operator. Allowlisting `claude.com` lets enrollment links be
delivered directly.

## Side effects considered

- **Weakens the provenance gate for claude.com?** Marginally and acceptably:
  `claude.com` is Anthropic's official first-party domain (same trust class as the
  already-listed `claude.ai`, `anthropic.com`, `docs.anthropic.com`). The allowlist
  exists precisely to stop second-guessing well-known service domains. The gate
  still flags every genuinely unfamiliar/fabricated domain — the regression test
  keeps `fabricated-domain.xyz` flagged.
- **Drift between the two copies.** Both are edited identically in this change. The
  template is authoritative; the inline is a can't-find-template fallback. No new
  divergence introduced.
- **Migration parity.** Existing agents receive the updated allowlist because
  `PostUpdateMigrator` re-writes `.instar/scripts/convergence-check.sh` from the
  template on every update run (built-in script, always overwritten) — no separate
  migration needed; the edit to the template IS the migration path.
- **No API, config, schema, or route surface touched.** Behavior-only change to a
  heuristic gate. No new dependencies. Idempotent.
- **Blast radius:** one extra alternation in one regex, in two places. Reversible
  by removing the `claude\.com` token.
