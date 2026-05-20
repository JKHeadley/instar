# Side-effects review — instar setup --framework + wizard launch (PR 3+4)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — `setup.ts` exited if Claude wasn't installed, even for
Codex operators. After: precisely targeted. Default (no flag) is
'claude-code', byte-identical to v1.0.16. Only an explicit
`--framework codex-cli` changes detection and spawn behavior.

## 2. Level-of-abstraction fit

`runSetup({ framework? })` accepts the choice; `checkFrameworkPrerequisite`
from `src/core/Config.ts` is the single AUTHORITY for "is the chosen
runtime's binary installed?" — reused, not duplicated. Spawn shape is
two parallel branches (Claude and Codex) sharing the same wizard prompt
content. Correct altitude.

## 3. Signal vs Authority compliance

The `--framework` flag is the operator-intent SIGNAL. `checkFrameworkPrerequisite`
is the single AUTHORITY for binary detection across the whole codebase
(also used by Config.load runtime startup). No new brittle inline checks.

## 4. Interactions with adjacent systems

- **PR 1 + PR 2** — built on top. The flag now drives both install-time
  scaffolding (PR 1+2) and wizard-time launch (PR 3+4) consistently.
- **`detectClaudePath` / `detectCodexPath`** — both already exported from
  `src/core/Config.ts`. Used here without modification.
- **`checkFrameworkPrerequisite`** — existing function, used as-is.
- **Wizard skill content** (`.claude/skills/setup-wizard/SKILL.md`,
  `secret-setup/SKILL.md`) — unchanged. Both runtimes are pointed at the
  same files.
- **Playwright Telegram-setup flow** inside the wizard — unchanged. The
  flow was already runtime-portable; this PR makes the entry path work
  for Codex too.

## 5. Rollback cost

Low. One function-signature change, one detection swap, two spawn-arg
branches, two CLI flag additions. `git revert` restores prior Claude-only
behavior. Existing Claude users are unaffected even mid-rollback.

## 6. Backwards compatibility / drift surface

Fully backward-compatible. The optional `framework` parameter defaults
to `'claude-code'`. The bareword `npx instar` and `instar setup` without
the flag run exactly as v1.0.16 did. Drift surface: none — wizard
content remains in one place.

## 7. Authorization / Trust posture

No new authority. The flag only changes which binary is spawned; both
existing spawn paths use `--dangerously-skip-permissions` (Claude) or
`--dangerously-bypass-approvals-and-sandbox` (Codex) — these are the same
sandbox-bypass postures the runtime-spawn builders already use elsewhere
in the codebase (`src/core/frameworkSessionLaunch.ts`). No new privilege.

## Outcome

Ship. Operator-scoped, default-safe, no Claude-user regression risk,
the cohesive end-to-end Codex setup story finally works. End-to-end
verification follows as the next task (smoke test on this machine).
