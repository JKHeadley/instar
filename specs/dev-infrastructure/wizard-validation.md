---
title: "Wizard input validation + composing indicator"
slug: "wizard-validation"
author: "echo"
eli16-overview: "wizard-validation.eli16.md"
review-convergence: "2026-05-21T23:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T23:30:00Z"
review-report: "docs/specs/reports/wizard-validation-convergence.md"
approved: true
---

# Wizard input validation + composing indicator

## Problem statement

End-to-end test of the v1.2.13 hybrid wizard on `instar-codey`
turned up a real UX failure. The user typed "1" + Enter at the
welcome prompt, then — because the next codex-narrative call took
several seconds with no visible feedback — pressed Enter again
thinking the terminal was frozen. The second Enter buffered in
stdin and was consumed by the NEXT readline (for the agent-name
prompt) as an empty submission. The state machine's defensive
fallback in agent-name's `next`:

```ts
updates: { agentName: answer.trim() || 'agent' },
```

…silently defaulted the agent's name to "agent". The wizard then
proceeded ("Love the name `agent`...") and the user ended up with
an agent named "agent" without ever having typed anything.

Justin's correct critique: *"An intelligent system would recognize
that the user hadn't actually entered the agent name. This is a
really poor user experience."*

Two root causes:

1. **Invisible latency**: codex exec calls take 5-15 seconds with
   nothing on screen. Users treat silence as a frozen terminal and
   press Enter, which buffers.
2. **No input validation**: the state machine accepted empty input
   on required fields and used a fallback default. Defaults are
   for crash recovery, not for "the user submitted nothing."

## Proposed design

Two structural fixes in `src/commands/setup-wizard/`.

### Fix 1: Per-state validators

Extend `NarrativeState` with an optional `validate(answer): string |
null` function. Returns `null` to accept, or a friendly message to
surface to the user before re-rendering the same state.

Two reusable validators added:

- `requireNonEmpty(fieldLabel)`: rejects whitespace-only input with
  "That looked blank — did an extra Enter slip through? Try typing
  a {fieldLabel}." This is explicitly worded to call out the
  buffered-Enter footgun by name.
- `requireChoice(choices)`: rejects input that doesn't match any
  choice (by number, value, or label prefix), with "I didn't
  recognize that — try typing one of the numbers (1-N) or the
  option name."

Wired into all narrative states in the fresh-project-install
graph: welcome (choice), agent-name (non-empty), agent-role
(non-empty), user-name (non-empty), autonomy (choice), messaging
(choice).

The driver's `renderNarrativeState` runs the validator after each
readline answer. On invalid input, the friendly message is printed
and `askUser` is called again — WITHOUT regenerating the narrative
paragraph (cheap loop, no extra codex calls). The narrative + the
structural prompt remain on screen between attempts.

Bounded at 5 retry attempts to prevent an infinite loop on a wedged
input. After 5 fails, the wizard accepts whatever was last typed —
the state machine's `next` function still produces a usable
transition.

### Fix 2: Composing spinner during codex calls

`startSpinner(label)` returns a `{ stop }` handle. On a TTY it
prints a single line with a rotating braille spinner ("⠋ composing…")
that updates every 100ms via `setInterval`. On non-TTY (CI, piped
output) it prints "composing…" once and stops the animation.

The spinner is started at the top of `runCodexNarrative` and
stopped in its `finally` block — guaranteed cleanup even on
timeout/error. When stopped, it overwrites its line with spaces +
`\r` so the narrative paragraph renders cleanly without a
leftover spinner artifact.

### Fix 3: Remove the silent-default fallback on required fields

The pre-fix `agent-name.next` was:

```ts
updates: { agentName: answer.trim() || 'agent' },
```

This was wrong — it accepted empty submissions and silently
defaulted them. Post-fix:

```ts
updates: { agentName: answer.trim() },
```

The validator catches empty input upstream, so `next` only ever
sees a non-empty answer.

Same change applied to agent-role, user-name. The autonomy and
messaging states use `resolveChoice` and were tightened to use the
non-null-assertion since the validator guarantees a valid match.

## Decision points touched

- Adds one structural input-validation primitive to the wizard
  state-machine API (`validate?: (answer) => string | null`).
- No new authority. Validators are pure functions; the driver still
  owns dispatch.
- No new framework dependency. Spinner uses node:setInterval +
  process.stdout.

## Open questions

None for this PR's scope.

## Out of scope

- Real-time stdin draining between turns. We rely on the validator
  to catch buffered-Enter via the empty-answer code path. Draining
  stdin reliably across platforms is finicky; the validator+spinner
  combination addresses the user-visible failure mode without
  needing it.
- Codex-driven "intelligent" interpretation of user answers (e.g.
  "did the user mean to type a name or were they confused?"). The
  validation layer handles the empty-input class structurally. If
  future cases call for richer interpretation, a separate spec can
  add an LLM-assisted validator.
- Spinner customization (frame rate, character set). The braille
  spinner is the standard. If terminals can't render it, a follow-
  up can fall back to ASCII dots.
