---
title: "Bareword `npx instar` asks which runtime"
slug: "bareword-framework-prompt"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "bareword-framework-prompt.eli16.md"
review-convergence: "2026-05-20T21:15:00Z"
review-iterations: 1
review-completed-at: "2026-05-20T21:15:00Z"
review-report: "docs/specs/reports/bareword-framework-prompt-convergence.md"
approved: true
approved-by: "Justin (2026-05-20, 'Yes please' to the proposed small follow-up PR)"
approved-date: "2026-05-20"
approval-note: "Final UX gap from the install/wizard portability arc. ~15-line change, doesn't reintroduce the commander parent-option interception bug because it's a runtime prompt, not a CLI flag."
lessons-engaged:
  - "P1 (Structure>Willpower): a runtime prompt rather than a doc telling users to know about --framework."
  - "P4 (Testing Integrity): 4-case unit test on the pure decision function (the readline interaction itself is end-to-end tested by Justin's manual run)."
  - "L1-equivalent: closes the UX gap left by the parent-option hotfix earlier today (#276)."
  - "L6/L9/L10: siblings."
---

# Bareword `npx instar` asks which runtime

## Problem

After the install/wizard portability arc and its parent-option hotfix
(#276), `npx instar setup --framework codex-cli` works end-to-end on a
Codex-only host. But the headline command — bareword `npx instar` with no
subcommand — silently defaults to Claude Code and exits if Claude isn't
installed. A fresh Codex-only user typing the most natural command has no
discoverable path.

## Change

`runSetup({framework?})` gains an interactive prompt that fires when:
- no `--framework` flag was passed (i.e. the bareword path), AND
- `process.stdin.isTTY` is true (interactive terminal — piped/CI runs
  keep their current default behavior).

The prompt presents both options with installed/not-installed indicators,
reads "1" / "2" / a framework name from stdin (default Claude Code on
empty input), and proceeds with the chosen framework. The rest of
`runSetup` is unchanged — the framework value flows into the existing
`checkFrameworkPrerequisite` call and the binary selection used by the
wizard spawn.

A pure decision helper `resolveFrameworkPromptBehavior(claudeDetected,
codexDetected)` is exported so the prompt-vs-auto-select logic is
unit-testable without spawning readline:

- both installed → prompt
- only Claude installed → auto-select Claude (no point asking)
- only Codex installed → auto-select Codex (no point asking)
- neither installed → prompt (so the user picks which one to install,
  and `checkFrameworkPrerequisite` surfaces the right install URL)

## What this is NOT

- Not a new CLI flag. The earlier `instar init --framework <name>` and
  `instar setup --framework <name>` keep working unchanged. The bareword
  was deliberately left without a `--framework` option after #276 to
  avoid commander's parent-option interception bug; this PR doesn't
  reintroduce that — it's a runtime prompt, not a flag.
- Not a change to non-interactive behavior. Piped invocations and CI runs
  (no TTY) keep defaulting to Claude Code.
- Not a change to subcommand flow.

## Testing

`tests/unit/bareword-framework-prompt.test.ts` — four cases pinning the
decision function across the four detection combinations. The readline
interaction itself is exercised by the manual end-to-end test on the
operator's machine after merge (smoke verifies `npx instar` on a TTY
displays the prompt and routes correctly).

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ runtime prompt, not a doc note |
| P4 Testing Integrity | ✓ 4-case unit test on the pure decision |
| P6 Zero-Failure | ✓ suite green |
| P10 Comprehensive-First | ✓ closes the bareword UX gap completely |
| L1 (audit-driven) | ✓ closes the UX gap left by hotfix #276 |
| L6/L9/L10 | ✓ siblings |

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/commands/setup.ts` — `resolveFrameworkPromptBehavior` (exported,
   pure) + `promptForFramework` (private, async, readline-driven) +
   one call from `runSetup` gated on `process.stdin.isTTY`.
3. `tests/unit/bareword-framework-prompt.test.ts` (NEW, 4 cases).
4. `upgrades/NEXT.md` — appended bareword section (combined v1.1.4 with
   the test-env isolation work already staged).
5. `upgrades/side-effects/feat-bareword-framework-prompt.md`.
