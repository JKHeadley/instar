---
title: "Setup wizard always runs on Claude"
slug: "wizard-via-claude"
author: "echo"
eli16-overview: "wizard-via-claude.eli16.md"
review-convergence: "2026-05-21T20:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T20:00:00Z"
review-report: "docs/specs/reports/wizard-via-claude-convergence.md"
approved: true
---

# Setup wizard always runs on Claude

## Problem statement

First real end-to-end test of `npx instar` → "Codex CLI" runtime
prompt → wizard launch (against v1.2.11, which fixed the model-pin
issue in PR #299) confirmed that the model flag now flows through
correctly. Codex was spawned with `model: gpt-5.3-codex`,
received the wizard skill prompt, and the wizard skill was loaded.

But the user experience was still broken in a different, deeper way:
**Codex did not follow the wizard's conversational contract.** The
`.claude/skills/setup-wizard/SKILL.md` says, in capitals at the top:

> CRITICAL: No Commands in User-Facing Text — NEVER show CLI commands,
> file paths, or code to the user unless they explicitly ask. Speak
> conversationally.

> CRITICAL: NEVER Use AskUserQuestion — Always present choices as
> inline numbered options in your text output, then wait for the user
> to type their choice.

> Display the AGENT SUMMARY block verbatim … and wait for the user to
> type their choice.

Codex parsed the JSON context, noticed `entryPoint: "restore"`,
internally resolved a scenario, and **executed the entire setup
non-interactively** before showing the user anything resembling a
walkthrough:

```
exec: /bin/zsh -lc 'pwd && ls -la …'
exec: /bin/zsh -lc 'git rev-parse --show-toplevel && git remote -v'
exec: /bin/zsh -lc 'npx instar --help'
exec: /bin/zsh -lc 'npx instar init --help'
exec: /bin/zsh -lc 'npx instar init --dir /Users/justin/Documents/Projects/instar-codey'
exec: /bin/zsh -lc 'sed -n "1,220p" .instar/AGENT.md'
exec: /bin/zsh -lc 'cat .instar/config.json'
exec: /bin/zsh -lc 'npx instar user add --id justin --name Justin'
exec: /bin/zsh -lc 'npx instar server start'
exec: /bin/zsh -lc 'npx instar autostart install --dir …'
exec: /bin/zsh -lc 'npx instar status'
```

The user never picked a name, an autonomy level, a personality, a
communication style. The agent was assigned a generic identity
(`Instar-codey`, generic principles) and a user identity invented from
shell context (`justin`). Only at the very end did Codex offer one
multiple-choice prompt — for messaging selection.

The wizard's stated job — "helping their agent come to life with a
real identity" — never happened. The skill's behavioral instructions
were treated as a task description by Codex's training, not as a
behavioral contract.

## Proposed design

Always spawn Claude for the setup wizard, regardless of which host
framework the user picked at the runtime prompt. This applies to both
interactive micro-sessions in `src/commands/setup.ts`:

1. The main wizard launch (after agent discovery + scenario resolution).
2. The Phase 2.5 secret-setup micro-session (Bitwarden / 1Password
   choice + install + unlock).

The `framework` variable still controls everything else: the agent's
`enabledFrameworks` in config.json, the framework-specific scaffold
gates (`.claude/` vs no-`.claude/`, `.codex/` overlay, AGENTS.md vs
CLAUDE.md, etc.), and post-setup runtime behavior. Only the interactive
wizard binary is forced to Claude.

### The justification

- The wizard's job is **conversational onboarding** — walk a fresh user
  through identity, personality, autonomy preferences, communication
  style, messaging setup. Claude reliably follows the skill's behavioral
  contract: pause for input, present inline numbered choices, never
  show CLI commands, speak in plain English.
- Codex's training pulls toward **execution**. When given the same
  skill prompt, Codex treats it as a task description and runs the
  setup non-interactively. Adding more "PAUSE HERE" markers won't
  fix it — Codex routinely ignores those too.
- Once setup is done, the **agent's runtime** continues to be whatever
  framework the user picked. Codex agents run on Codex. Claude agents
  run on Claude. The wizard is just the onboarding tool.

### Prerequisite

Claude must be installed even on hosts whose agent will run on Codex.
This is already required today: `ensurePrerequisites` checks Claude
unconditionally and the prerequisites check passes only when Claude is
present (per the v1.2.11 install log, line 12: `✓ Claude CLI`). If
Claude is missing, the wizard now surfaces a clean refusal explaining
that Claude is the conversational onboarding tool, and the agent can
still run on Codex once setup is complete.

A future PR may add a true Codex-only-host wizard if/when a user reports
needing it. Out of scope for this fix.

### Concrete changes

In `src/commands/setup.ts`:

- Replace `const binaryPath = framework === 'codex-cli' ? codexPath! :
  claudePath!;` with a refusal check + `const wizardBinary =
  claudePath;` (always Claude).
- Replace the wizard launch's framework-conditional `launchArgs`
  ternary with the unconditional Claude form (`['--dangerously-skip-
  permissions', '/setup-wizard …']`).
- Replace the secret-setup spawn's framework-conditional `secretArgs`
  ternary with the unconditional Claude form (`['--dangerously-skip-
  permissions', '/secret-setup']`).
- Update the spawn error message to explain that the wizard runs on
  Claude.

The `WIZARD_CODEX_MODEL` constant from PR #299 remains exported as a
public symbol — it's no longer used inside setup.ts but external
callers may consume it, and removing public API would be a SemVer
breaking change for a non-blocking concern.

### Test contract

Update `tests/unit/setup-codex-model-canary.test.ts` to assert the
v1.2.12 contract:

- No `'-m' WIZARD_CODEX_MODEL` literal in setup.ts (no codex spawns
  remain there).
- No `codex exec` argv string in setup.ts.
- The `wizardBinary` assignment references `claudePath` and is NOT
  conditional on `framework`.
- The retired `gpt-5.2-codex` literal still never appears.

If a future PR re-introduces a Codex spawn for the wizard or secret-
setup, the test fails in CI before the change ships.

## Decision points touched

- Removes one operator-intent SIGNAL (the `framework` value's
  influence on `wizardBinary`).
- Does NOT add a new authority. The new refusal check (Claude must be
  installed) reuses `detectClaudePath`'s existing result.
- The agent's runtime behavior (post-setup) is unchanged.

## Open questions

None. The fix is a binary-selection change in two spawn callsites,
plus an updated canary.

## Out of scope

- Wizard support for hosts without Claude installed. Today
  `ensurePrerequisites` requires Claude regardless of framework, so
  the assumption holds. If a Codex-only-host install requirement
  arises, a separate spec can design the codex-only wizard variant
  (likely a state-machine driver rather than a free-form LLM prompt).
- Reusing the SKILL.md to drive a hand-rolled conversation manager
  for Codex. Possible but heavier; deferred.
- Deprecation of `WIZARD_CODEX_MODEL`. Kept exported as a public
  symbol; no breaking change in this PR.
