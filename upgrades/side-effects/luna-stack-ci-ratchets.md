# Side-effects review: luna-stack-ci-ratchets

## Change
- `src/core/PostUpdateMigrator.ts`: one existing `catch { machineId = undefined; }` reformatted to carry an in-brace `@silent-fallback-ok` comment. Same statement, same control flow.
- `src/core/SubscriptionPoolAuthority.ts`: `witnessOperation()` and `legacySourceMatches()` catch blocks reformatted with in-brace `@silent-fallback-ok` comments. Same return values (`null`, `false`).
- `site/src/content/docs/features/observability.md`: one sentence and two component names added to the Token ledger section.

## Over-block / under-block
None. No runtime logic changed; emitted JavaScript is identical apart from comments.

## Level of abstraction
Comment annotations satisfy the existing no-silent-fallbacks ratchet; the doc sentence satisfies the docs-coverage floor. Both are the mechanisms the ratchets name.

## Signal vs authority
No decision points added or changed.

## Interactions
None. No routes, config, migrations, hooks, or templates touched.

## External surfaces
Public docs page gains one accurate sentence (verified against the CodexRolloutParser and CodexRolloutScan.worker source headers).

## Rollback
Revert the commit; only comments and docs change.
