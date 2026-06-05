# Session Boot Self-Knowledge — vault secret names + operational facts at boot

## What to Tell Your User

Nothing user-visible yet — the feature ships dark on the fleet (live on the development agent for the bake). When the fleet flip lands it gets its own note: "your agent now remembers what credentials it holds across sessions — it won't ask you to re-send a key it already has."

## Summary of New Capabilities

- `GET /self-knowledge/session-context` (Bearer; `enabled ?? !!developmentAgent`): a bounded, sanitized `<session-self-knowledge>` block with the agent's vault secret NAMES (never values; same `secretKeyPaths()` derivation as `/secrets/sync-status`, depth-capped) + self-asserted operational facts. `?full=1` bypasses the display caps. A vault that exists but won't decrypt is reported honestly as DECRYPT-FAILED with hands-off guidance — never as an empty vault.
- `POST/DELETE /self-knowledge/facts`: agent-driven writer for durable per-machine operational facts (auto-stamped `{fact, updatedAt, machine}`; duplicate/cap/ambiguity guarded; atomic temp+rename config write).
- `.instar/scripts/secret-get.mjs` (always-overwrite installed): hardened vault retrieval — value streams to stdout for piping straight into the consuming command, names/diagnostics to stderr, zero value bytes on any error path.
- The session-start hook injects the block at every boot (fail-open: dark/unreachable/version-skew → silent skip), placed after the org-intent and preferences blocks.
- Structural test guard: `MasterKeyManager` forces the file key under vitest — no test can ever read or overwrite the machine-global OS keychain master key again (the 2026-06-05 bifurcated-key incident class is closed).

## What Changed

New `src/core/BootSelfKnowledge.ts` (block builder: sanitization, depth-2 collapse, alphabetical + capped + byte-bounded rendering, mtime+size-keyed module cache); three routes in `routes.ts`; one fetch block in `getSessionStartHook()`; `selfKnowledge` config surface (defaults backfilled by `migrateConfig`, `enabled` left unset for the developmentAgent gate); CLAUDE.md template section + `migrateClaudeMd` parity; `secret-get.mjs` shipped via `migrateScripts` + init. Spec: `docs/specs/session-boot-self-knowledge.md` (converged, 3 iterations, cross-model codex-cli:gpt-5.5).
