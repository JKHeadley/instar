---
title: "Codex-only init produces zero .claude/ files (PR 2/4)"
slug: "install-claude-gating"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "install-claude-gating.eli16.md"
review-convergence: "2026-05-20T03:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-20T03:00:00Z"
review-report: "docs/specs/reports/install-claude-gating-convergence.md"
approved: true
approved-by: "Justin (2026-05-20, autonomous-mode pre-auth for the four-PR install/wizard portability series)"
approved-date: "2026-05-20"
approval-note: "PR 2/4. Makes the v1.0.15 `--framework` flag actually mean something at install time."
lessons-engaged:
  - "P1 (Structure>Willpower): gated by code in every init path, not a doc note."
  - "P4 (Testing Integrity): 3-case test asserts codex-only produces ZERO .claude/ entries, default keeps CLAUDE.md+.claude/, dual produces both."
  - "P10 (Comprehensive-First): all three init paths (fresh, existing, standalone) + refreshHooksAndSettings + refreshScripts gated. No half-fix."
  - "L1-equivalent (audit-driven): closes audit blocker 4 (installClaudeSettings unconditional)."
  - "L6/L9/L10: siblings."
---

# Codex-only init produces zero .claude/ files (PR 2 of 4)

## Problem

PR 1 (v1.0.15) added `--framework` to `instar init` and persisted the
choice as `enabledFrameworks` in config. But the install paths still wrote
all Claude-Code-specific files unconditionally — `.claude/settings.json`,
`.claude/scripts/health-watchdog.sh`, `.claude/scripts/smart-fetch.py`,
`.claude/scripts/git-sync-gate.sh`, `.claude/skills/`, and the rich
CLAUDE.md instruction document. A user picking `--framework codex-cli`
got both the codex-shaped files (AGENTS.md, etc.) AND the Claude-shaped
files. Codex-only purity (the audit's success criterion) was unmet.

## Change

`claudeEnabled = resolveEnabledFrameworks(options.framework).includes('claude-code')`
gates every `.claude/`-targeting installer in every init path:

- **`initFreshProject`** — `installClaudeSettings`, `installHealthWatchdog`, `installSmartFetch`, `installGitSyncGate`, `.claude/skills/` install, CLAUDE.md write.
- **`initExistingProject`** — same set.
- **`initStandaloneAgent`** — `claudeDir` creation, `.claude/settings.json` write, CLAUDE.md write.
- **`refreshHooksAndSettings`** — `installClaudeSettings`, `refreshClaudeMd`, `.claude/skills/` install. (Reads `enabledFrameworks` from the persisted config — handles the post-install update path.)
- **`refreshScripts`** — `installSmartFetch`, `installGitSyncGate` (both target `.claude/scripts/`).

What stays unconditional (framework-neutral):
- `.instar/AGENT.md`, USER.md, MEMORY.md, soul.md, config.json
- `.instar/hooks/instar/` behavioral guardrails
- `.instar/scripts/serendipity-capture.sh`
- `.instar/scripts/telegram-reply.sh` (framework-neutral after Gap 4)
- AGENTS.md and GEMINI.md shadows rendered from canonical AGENT.md by `renderNonClaudeIdentityShadows`
- Machine identity, manifest signing key, builtin agentmd jobs

## What this is NOT

- Not a change to default behavior. `instar init` without the flag (or with `--framework claude-code` or `--framework both`) produces the same output it did in v1.0.15.
- Not the `setup` flag. PR 3 adds the same `--framework` flag to `setup`.
- Not the wizard routing. PR 4 routes the wizard through the chosen CLI.
- Not a change to how existing Claude-only agents update. They keep working — the helper defaults to `['claude-code']` when the field is unset.

## Testing

`tests/unit/init-claude-gating.test.ts` — three cases:
- Codex-only standalone init produces NO `.claude/` directory, NO CLAUDE.md, but DOES produce AGENTS.md and persists `enabledFrameworks: ['codex-cli']`.
- Default (no flag) standalone init keeps CLAUDE.md + `.claude/settings.json` exactly as v1.0.15 did.
- `--framework both` produces both CLAUDE.md AND AGENTS.md, both .claude/ AND the canonical state.

Plus the five PR 1 tests (still passing) — together 8 cases verify the
full mechanism.

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ code gates, not docs |
| P4 Testing Integrity | ✓ 3 cases, both decision sides + dual |
| P6 Zero-Failure | ✓ suite green |
| P10 Comprehensive-First | ✓ all 3 init paths + 2 refresh helpers gated |
| L1 (audit-driven) | ✓ closes audit blocker 4 |
| L6/L9/L10 | ✓ siblings |

No contradictions. PR 3-4 are distinct blockers.

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/commands/init.ts` — `claudeEnabled` derived once per init function; wraps all `.claude/`-targeting installers and CLAUDE.md writes.
3. `tests/unit/init-claude-gating.test.ts` (NEW, 3 tests).
4. `upgrades/NEXT.md` (v1.0.16, combined with prior staged changes).
5. `upgrades/side-effects/feat-install-claude-gating.md`.
