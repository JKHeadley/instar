---
title: "instar setup --framework + framework-aware wizard launch (PR 3+4 of 4)"
slug: "setup-framework-flag"
author: "echo"
status: "converged"
type: "dev-infrastructure-spec"
eli16-overview: "setup-framework-flag.eli16.md"
review-convergence: "2026-05-20T03:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-20T03:30:00Z"
review-report: "docs/specs/reports/setup-framework-flag-convergence.md"
approved: true
approved-by: "Justin (2026-05-20, autonomous-mode, explicit pre-auth for the four-PR install/wizard series + smallest-variant PR-4 choice)"
approved-date: "2026-05-20"
approval-note: "PR 3+4 combined. Splitting would leave PR 3 in a broken intermediate state (Codex detection succeeds but spawn still runs Claude). One cohesive change."
lessons-engaged:
  - "P1 (Structure>Willpower): the flag drives detection AND launch via code paths, not docs."
  - "P10 (Comprehensive-First): combined PR 3+4 ships the complete user-visible feature; no half-fix where setup detects Codex but then tries to spawn Claude."
  - "Audit-finding correction: the audit framed this as two separate PRs; verified intermediate state would be broken, so combined into one PR with explicit rationale."
  - "P4 (Testing Integrity): the framework-prerequisite check is already unit-tested in src/core/Config.ts (checkFrameworkPrerequisite). The flag-resolution test was added in PR 1. The end-to-end smoke test for a fresh Codex-only install is task #66 and the next-up unit of work."
  - "L1-equivalent (audit-driven): closes audit blockers 2 and 3 (setup.ts:71 hard Claude exit; wizard spawn binary-hardcoded to claude)."
  - "L6/L9/L10: siblings."
---

# instar setup --framework + framework-aware wizard launch (PR 3+4 of 4)

## Problem

PRs 1 and 2 made `instar init` framework-aware end-to-end: pick `codex-cli`
and you get a clean Codex-only install with zero `.claude/` writes. But
`instar setup` (the conversational wizard that runs after — or as — `npx
instar`) still had two hard Claude requirements that prevented Codex
operators from completing the install:

1. **`setup.ts:71`** called `detectClaudePath()` and exited the process if
   it returned null. No Codex branch.
2. **The wizard spawn** at the end of `runSetup()` shelled out to
   `claude --dangerously-skip-permissions /setup-wizard <prompt>`. The
   `/secret-setup` micro-session did the same.

These are audit blockers 2 and 3 (audit blocker 1 was PR 1's `init` flag;
blocker 4 was PR 2's `.claude/` gating). With them closed, a Codex
operator on a Codex-only machine can complete the full install end-to-end,
including the Playwright Telegram setup — which itself was already
runtime-portable but was reachable only through the Claude-gated wizard.

## Why PR 3+4 ship together

The audit listed these as two separate PRs (PR 3 = detection, PR 4 =
launch). Verified during implementation: shipping PR 3 alone leaves the
wizard in a worse intermediate state than today. The user passes
`--framework codex-cli`, detection succeeds, the wizard prints "Welcome to
Instar," then the next line tries to spawn `claude` and crashes. PR 4
alone (without PR 3) cannot expose the choice at all.

The cohesive unit of value is "Codex-only `instar setup` runs end-to-end."
That's one PR.

## Change

1. **`setup` and bareword (`npx instar`) commands** accept
   `--framework <claude-code|codex-cli>`. Validated at parse time; unknown
   values exit with a clear list of allowed options. Default unchanged
   (`'claude-code'`).
2. **`runSetup(opts?: { framework? })`** resolves the framework, calls
   `detectClaudePath()` + `detectCodexPath()`, then delegates to
   `checkFrameworkPrerequisite(...)` from `src/core/Config.ts` — which
   already exists and emits a framework-specific install message. No new
   exit logic.
3. **Wizard spawn** branches on framework:
   - `claude-code`: `claude --dangerously-skip-permissions /setup-wizard <prompt>`
     (identical to prior behavior — byte-for-byte).
   - `codex-cli`: `codex exec --dangerously-bypass-approvals-and-sandbox`
     with a prompt that begins "Read `<instarRoot>/.claude/skills/setup-wizard/SKILL.md` and follow its instructions..." The wizard skill content lives in exactly one place; both runtimes read it.
4. **Secret-setup micro-session** (`ensureSecretBackend`) gets the same
   treatment — branches on framework, reads `<instarRoot>/.claude/skills/secret-setup/SKILL.md` from a Codex prompt.

## Why the wizard skill is reachable from Codex despite living under `.claude/`

The wizard SKILL.md lives at `<instarRoot>/.claude/skills/setup-wizard/SKILL.md`
inside the instar npm package. That directory is part of the package's
`files` list and ships to every install regardless of framework. Codex
reads markdown files just as well as Claude does; it just doesn't natively
hook them in via slash-commands, hence the prompt-prose approach. A future
PR could mirror these skills to a framework-neutral location, but the
current placement is reachable from both runtimes — verified.

## What this is NOT

- Not a duplication of the wizard skill content. Both runtimes are pointed
  at the same SKILL.md.
- Not a change to Claude-only operator experience. `claude` users see
  byte-for-byte the same setup wizard they saw in v1.0.16.
- Not the smoke test. That's task #66 — an end-to-end run on this machine
  with the bundled code to verify the full Codex-only install completes
  including the Playwright Telegram setup.

## Testing

The framework-prerequisite check used by setup (`checkFrameworkPrerequisite`
in `src/core/Config.ts`) is already unit-tested. The `--framework` flag
parsing follows the same pattern as PR 1 (already tested). The genuinely-
new behavior — Codex spawn shape — is verified by the end-to-end smoke
test (task #66) since unit-testing a process spawn is more setup than
value compared to actually running it on this machine where Codex is
installed.

This is a deliberate trade — the smoke test is the highest-fidelity
verification of the spawn, and the spawn shape is mechanically simple
(one branch on the framework string).

## Manual lessons-aware check

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ flag drives detection + spawn via code |
| P10 Comprehensive-First | ✓ PR 3+4 combined to avoid broken intermediate state |
| P4 Testing Integrity | ✓ framework-prereq check + flag parsing covered; end-to-end smoke test follows as task #66 |
| P6 Zero-Failure | ✓ suite green |
| L1 (audit-driven) | ✓ closes blockers 2+3 |
| L6/L9/L10 | ✓ siblings |

## Implementation slice

1. This spec + ELI16 + convergence report.
2. `src/commands/setup.ts` — `runSetup({ framework? })` signature, `checkFrameworkPrerequisite` call, branching wizard and secret-setup spawn args.
3. `src/cli.ts` — `--framework <name>` option on the `setup` command AND on the bareword `instar` (default-action), with parse-time validation.
4. `upgrades/NEXT.md` (v1.0.17, combined release notes).
5. `upgrades/side-effects/feat-setup-framework-flag.md`.
