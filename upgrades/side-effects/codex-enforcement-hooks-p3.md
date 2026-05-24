# Side-Effects Review: Codex enforcement hooks — P3 (migration parity)

## Change
`PostUpdateMigrator.migrateHooks()` now calls `installCodexHooks(this.config.projectDir)` gated on `getEnabledFrameworks().includes('codex-cli')`, writing the per-project `.codex/hooks.json` for existing Codex agents on update. + import.

## Why (Migration Parity Standard — non-negotiable)
`installCodexHooks` ran ONLY from init's `refreshHooksAndSettings` (verified: that function's sole caller is `init.ts`). Existing agents update via `PostUpdateMigrator`, which wrote the gate SCRIPTS (with the P2 shim) but NOT the `.codex/hooks.json` registration. So without this, an existing Codex agent would get the updated guard scripts yet never the registration that makes Codex fire them — "works for new agents only" = broken. This closes it.

## Scope
- On update, codex-cli agents get `.codex/hooks.json` written/refreshed (idempotent; preserves user-added Codex hooks via the command-path ownership check). Claude-only agents unaffected (gated). The referenced gate scripts are written earlier in the same `migrateHooks` pass.

## Idempotency
- Tested: repeated migration yields exactly one instar PreToolUse group (no accumulation).

## Signal vs Authority / Over-block
- Unchanged from P1/P2 — this only ensures the registration reaches existing agents. No new authority, no new block patterns.

## Rollback
- Revert the `migrateHooks` codex block + the import. No data migration.

## Tests
- 3 migration tests: codex-cli agent → `.codex/hooks.json` written (with dangerous-command-guard in PreToolUse); claude-only → not written; idempotent across repeated migrations. Full P1–P3 sweep: 17 green. tsc + lint clean.

## Publish
- Feature branch. Not shipped.
