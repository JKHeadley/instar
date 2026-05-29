# Side Effects Review — capabilities auth self-discovery

## Change

Align agent-facing self-discovery instructions with the runtime server contract:
capability checks require the configured Bearer token.

## Surfaces Touched

- Fresh init CLAUDE.md generation.
- Post-update CLAUDE.md migration for existing agents.
- Built-in manifest regeneration for changed source templates.

## Expected Effects

- Agents following "know before you claim" get the capability matrix instead of
  an authentication error.
- Existing stale CLAUDE.md files are corrected during update without requiring a
  full re-init.

## Risk Review

- The change does not relax API auth or expose capability data publicly.
- The migrator rewrite targets only unauthenticated localhost capabilities curl
  commands and replaces them with the authenticated form for the configured
  server port.
- Existing already-authenticated commands are left unchanged.

## Validation

- Focused unit coverage covers both rewrite and missing-section insertion.
