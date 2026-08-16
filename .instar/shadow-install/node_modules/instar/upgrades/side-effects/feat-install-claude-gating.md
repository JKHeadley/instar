# Side-effects review — Codex-only init zero .claude/ (PR 2 of 4)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — `--framework codex-cli` was expressed but ignored; all
`.claude/` writes fired anyway. After: precisely gated. Default (no flag,
or `claude-code`, or `both`) is byte-identical to v1.0.15. Only an explicit
codex-only choice changes anything.

## 2. Level-of-abstraction fit

`claudeEnabled` is derived once per init function (or per refresh helper)
from the canonical `enabledFrameworks` value. The pure
`resolveEnabledFrameworks(choice)` helper (PR 1) is the single resolver
for flag-provided values; `refreshHooksAndSettings` and `refreshScripts`
read the persisted config directly with the same default semantics. No
brittle inline re-derivation.

## 3. Signal vs Authority compliance

The flag (PR 1) and the persisted `enabledFrameworks` are the SIGNAL of
operator intent. Each init/refresh function's local `claudeEnabled`
variable is the single AUTHORITY for that function's gating. No leak of
the framework concept into the installer functions themselves
(`installClaudeSettings`, `installSmartFetch`, etc.) — they remain
unchanged.

## 4. Interactions with adjacent systems

- **PR 1 (`--framework` flag)** — built on top. PR 2 makes the flag's
  persisted value actually do something at install/refresh time.
- **`PostUpdateMigrator.getEnabledFrameworks()`** (v1.0.11) — uses the
  same default semantics. The two readers are consistent.
- **`IdentityRenderer.renderNonClaudeIdentityShadows`** — unchanged, still
  runs unconditionally for AGENTS.md/GEMINI.md.
- **`installHooks(stateDir)`** — unchanged; it writes to `.instar/hooks/`,
  framework-neutral.
- **`migrateScripts` in PostUpdateMigrator** — already framework-aware for
  the relay script (Gap 4 / v1.0.10). The `.claude/scripts/` writes in
  `refreshScripts` are now consistently gated.

## 5. Rollback cost

Low. Five gates in init.ts (all near-identical `if (claudeEnabled)` wraps)
+ one new test file. `git revert` restores prior behavior. Existing
configs with or without `enabledFrameworks` continue to be readable by
older versions.

## 6. Backwards compatibility / drift surface

Fully backward-compatible. Default behavior preserved. Drift surface:
none new — five gate sites read from the same persisted field with the
same default.

## 7. Authorization / Trust posture

No new authority. The gates only *prevent* writes for codex-only installs;
they never grant new writes. Unreadable config defaults to `['claude-code']`
(status quo). Cannot escalate, cannot read additional resources.

## Outcome

Ship. Operator-scoped, default-safe, fully tested (the codex-only zero-
`.claude/` guarantee is pinned by an isolated-fs end-to-end test). PR 2 of
4 of the install/wizard portability series.
