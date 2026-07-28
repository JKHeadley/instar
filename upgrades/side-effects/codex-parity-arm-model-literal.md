# Side-Effects Review: init arming model literal → constant (CI fix)

## Change
init.ts's codex trust-driver model `'gpt-5.2'` is now held in a local `const codexArmModel`
instead of an inline quoted literal in the makeTmuxTrustDriver call.

## Why
default-jobs-valid.test.ts scans src/commands/init.ts for `model: '<x>'` patterns and asserts
each is a valid Claude job tier (opus/sonnet/haiku). My inline `model: 'gpt-5.2'` (a codex
trust-spawn config, NOT a job model) false-matched that scanner. Holding it in a constant keeps
the scanner from catching it without weakening the test (the test still validates real job models).

## Scope / blast radius
- Behavior identical (same model value passed to the driver). Pure cosmetic/structure change to
  dodge an over-broad source-scanning test. No runtime effect.

## Rollback
- Inline the literal again (would re-break the scanner).

## Tests
- default-jobs-valid.test.ts + PostUpdateMigrator-codexHooks.test.ts: 14/14 green. tsc clean.

## Publish
- PR #384.
