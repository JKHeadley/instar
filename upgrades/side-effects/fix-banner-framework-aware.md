# Side-effects review — Welcome banner framework-aware

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER (cosmetic). The welcome banner always said "Claude
Code" regardless of the user's runtime choice. After: precisely
correct. Banner reads the resolved `framework` value (already in
scope from the v1.2.1 bareword prompt) and prints the matching
runtime + sandbox flag.

No over-block: the framework-neutral parts of the banner are
unchanged.

## 2. Level-of-abstraction fit

Two local constants in `runSetup` derive from the existing
`framework` variable. One log line uses template interpolation
instead of a string literal. No new module, no new abstraction.

## 3. Signal vs Authority compliance

The runtime selection from the bareword prompt is the AUTHORITY
for which framework the agent uses. The banner now treats that
same AUTHORITY as the source of truth for the display label,
rather than diverging.

## 4. Interactions with adjacent systems

- **Bareword runtime prompt (v1.2.1)**: unchanged. Same flow, same
  value flowing into `framework`.
- **Sandbox-bypass flags**: the banner now matches the actual flags
  passed to the spawned runtime — `--dangerously-bypass-approvals-
  and-sandbox` for Codex (per src/commands/setup-wizard/codex-
  driver.ts) and `--dangerously-skip-permissions` for Claude (per
  the existing slash-command spawn in setup.ts).
- **Wizard skill files**: unchanged.
- **Tests**: 4 new canary tests pin both branches of the banner +
  the template-interpolation shape.

## 5. Rollback cost

Trivial. One log line + two local consts. `git revert` restores
the v1.2.15 hardcoded text.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible. Claude users see the same banner they
saw before. Codex users see the correct banner instead of a wrong
one. No config schema change. No agent-installed-files change. No
PostUpdateMigrator work.

Drift surface: if a third framework is added in the future
(GEMINI?), the ternary needs extension. The canary test will
surface that by failing on the missing branch (expected behavior
— forces conscious update).

## 7. Authorization / Trust posture

No new authority. Display change only.

## Outcome

Ship. Closes the cosmetic-but-trust-eroding misdisplay on Codex
installs.
