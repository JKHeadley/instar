# Upgrade Guide — v1.2.14 (wizard validation + composing indicator)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the wizard now catches buffered-Enter and surfaces a visible
indicator during Codex narrative calls.**

End-to-end testing v1.2.13 on a real Codex install surfaced a UX
failure. The user typed an answer and pressed Enter, then — because
the next Codex-narrative call took several seconds with no visible
feedback — pressed Enter again thinking the terminal was frozen. The
extra Enter buffered in stdin, was consumed by the next prompt as
an empty submission, and the wizard silently defaulted the agent's
name to "agent". The user ended up with an agent that had a generic
identity they never picked.

Two structural fixes, both in `src/commands/setup-wizard/`:

1. **Per-state validators** on the state machine. Each
   narrative-then-prompt state can now declare a `validate` function
   that rejects invalid input and surfaces a friendly retry message
   without re-generating the Codex narrative paragraph (cheap loop,
   no extra LLM calls). Reusable validators:
   - `requireNonEmpty(fieldLabel)`: rejects whitespace-only
     submissions on required text fields with an explicit
     "did an extra Enter slip through?" nudge.
   - `requireChoice(choices)`: rejects unmatched input on choice
     prompts with a "try one of these numbers" nudge.

   Wired on every narrative state in the fresh-project-install
   graph. Bounded at 5 retry attempts to prevent infinite loops
   on wedged input.

2. **Composing spinner** during codex narrative calls. A braille
   spinner ("⠋ composing…") animates on a single line while
   `codex exec` runs; clears cleanly when the paragraph arrives.
   On non-TTY (CI, piped output) it prints "composing…" once and
   stops. Eliminates the silent-dead-air window that triggered
   buffered-Enter in the first place.

The silent-default fallback that accepted empty agent-name as
"agent" is removed. With validators upstream, the state machine
only ever sees valid input.

Spec: `specs/dev-infrastructure/wizard-validation.md`.
ELI16: `specs/dev-infrastructure/wizard-validation.eli16.md`.
Side-effects review: `upgrades/side-effects/fix-wizard-validation.md`.

## What to Tell Your User

The setup wizard now shows a spinner while it's thinking, so you
can tell the system is working during the longer steps. If you
accidentally press Enter twice (which is easy to do during the
think pauses), the wizard will catch it and re-ask the question
instead of silently moving on with a blank answer.

## Summary of New Capabilities

No new capabilities. UX hardening on top of v1.2.13's hybrid wizard.

## Evidence

Reproduction prior to fix: v1.2.13 install on `instar-codey` with
Codex CLI. User entered "1" + Enter at welcome, then pressed Enter
again during the silent codex-narrative call. The second Enter was
consumed by the agent-name prompt as an empty submission;
agentName defaulted to "agent"; wizard proceeded with the generic
identity.

After fix:
- 14 new state-machine unit tests cover the two validator helpers
  and the per-state validator wiring (welcome, agent-name,
  agent-role, user-name, autonomy, messaging).
- Existing 12 state-graph tests still pass.
- Existing 5 dispatch canary tests still pass.
- Manual end-to-end re-test pending on publish.
