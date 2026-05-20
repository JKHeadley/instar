# Side-effects review — install --framework flag (PR 1 of 4)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — no UI for framework choice; even with all downstream
machinery in place (PostUpdateMigrator, ParitySentinel, IdentityRenderer)
the install always produced Claude-shaped scaffolding. After: no
over-block. Default (no flag) is `['claude-code']` — byte-identical
to today's behavior. Only an explicit `--framework codex-cli` or `both`
changes the persisted config.

## 2. Level-of-abstraction fit

CLI option lives in `cli.ts`. The flag value resolution is a pure helper
(`resolveEnabledFrameworks`) — testable in isolation, no side effects.
Config-write integration is at the three init paths' existing config
object literals. Correct altitude — option parsing at CLI boundary,
business logic in pure function, persistence at the existing write sites.

## 3. Signal vs Authority compliance

The `--framework` flag is the SIGNAL of operator intent.
`resolveEnabledFrameworks()` is the single AUTHORITY for the persisted
shape. PostUpdateMigrator's `getEnabledFrameworks()` (added v1.0.11)
is the single reader. No brittle inline duplication.

## 4. Interactions with adjacent systems

- **`PostUpdateMigrator.getEnabledFrameworks()`** (v1.0.11) already
  reads this field with the same default. Now the field actually gets
  written at install time. Consistent.
- **`FrameworkParitySentinel`** has its own `enabledFrameworks` config
  (different object); names intentionally mirror, no shared mutable
  state, no coupling introduced.
- **PRs 2-4** depend on this field being written; this PR makes them
  possible without itself changing any gating.
- **Existing Claude-only installs** are unaffected (default `['claude-code']`
  preserves all current writes).

## 5. Rollback cost

Low. One CLI option add + one type field + one helper + three identical
config-literal additions + one test file. `git revert` restores prior
behavior; existing configs that have `enabledFrameworks` are still
readable by older versions (the field is optional everywhere).

## 6. Backwards compatibility / drift surface

Fully backward-compatible: the flag is optional; the helper defaults
to historical behavior. Configs created without the flag have no
`enabledFrameworks` field; PostUpdateMigrator's helper already defaults
to `['claude-code']` when the field is unset. Drift surface: none — one
helper, one config field, three call sites using identical syntax.

## 7. Authorization / Trust posture

No new authority. The flag only changes what's persisted at install
time. Cannot escalate privileges, cannot read additional resources.
Invalid flag values exit with error at parse time.

## Outcome

Ship. Foundation for PRs 2-4. Default-safe, drift-reducing, tested.
