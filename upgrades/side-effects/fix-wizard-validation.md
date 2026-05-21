# Side-effects review — Wizard input validation + spinner

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER. The v1.2.13 hybrid wizard accepted empty submissions
on required identity fields with a silent fallback default
(agentName: 'agent'). Combined with the invisible-latency window on
codex-narrative calls, this produced the buffered-Enter bug Justin
hit on his first real Codex install — agent named "agent" without
the user ever typing a name.

After: precisely targeted. Validators enforce non-empty input on
required text fields and reject unmatched input on choice prompts.
Spinner during codex calls eliminates the silent-dead-air window
that triggers buffered-Enter in the first place. No over-block:
optional/derived fields keep their defaults; the validation
machinery only kicks in for fields the wizard explicitly marks as
required.

## 2. Level-of-abstraction fit

The `validate?` field is an optional addition to the existing
`NarrativeState` interface. Two reusable validators
(`requireNonEmpty`, `requireChoice`) live alongside the state
graph in `state-machine.ts`. The driver's `renderNarrativeState`
adds a bounded retry loop around `askUser`. The spinner is a
single utility function with a `{stop}` handle pattern.

No new module, no new abstraction layer. The state machine's API
grew by exactly one optional field.

## 3. Signal vs Authority compliance

- The validator's return value is the AUTHORITY for "is this
  answer accepted." The driver respects it without second-guessing.
- The user's input remains the SIGNAL; the validator transforms
  invalid SIGNALs into "retry with this hint" rather than silently
  defaulting.
- The spinner is purely visual feedback — no authority, no signal.

## 4. Interactions with adjacent systems

- **State machine `next` functions**: simplified. The pre-fix code
  on agent-name etc. was `answer.trim() || 'agent'`; post-fix is
  `answer.trim()`. The validator ensures `next` only sees non-empty
  trimmed input.
- **Codex driver dispatch in setup.ts**: unchanged. setup.ts still
  routes codex-cli installs through `runCodexWizard`.
- **runCodexNarrative**: now wraps its spawnSync in a spinner
  start/stop. Spinner is a no-op on non-TTY (CI, piped output) so
  test environments aren't affected.
- **Existing canary test** (`tests/unit/setup-codex-model-canary.test.ts`):
  unchanged. Asserts the same dispatch contract; the validator
  additions don't touch the dispatch shape.
- **State-machine unit tests**: expanded from 12 to 26 cases.
  Added validator-specific tests (requireNonEmpty, requireChoice,
  per-state validator wiring).
- **Claude wizard path**: completely unaffected. Validators live on
  the state-machine API, but the Claude path doesn't go through
  the state machine — it spawns the existing /setup-wizard
  slash-command directly.

## 5. Rollback cost

Low. New optional `validate` field on NarrativeState; new
validators; new spinner helper; one retry loop in the driver.
`git revert` restores v1.2.13 (with the buffered-Enter bug).

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- States without a `validate` function skip validation entirely
  and accept the answer immediately. No existing state is broken
  by the addition.
- Validators are pure functions with stable contracts. Drift
  surface: validator messages. If a message text needs to change,
  update the validator's return value — visible in PR diff.
- No config schema change. No agent-installed-files change. No
  PostUpdateMigrator work.

## 7. Authorization / Trust posture

No new authority. The validator is run inside the same wizard
process with the same user. No new privilege, no new sandbox, no
new auth.

## Outcome

Ship. Closes the broken-on-buffered-Enter UX hole that the
instar-codey real-user test surfaced. Structural validation +
visible composing indicator together address the failure-mode
chain (silent latency → user reflex → buffered Enter → empty
submission accepted). Validator extensibility lands cleanly on
the existing state-machine API. 26 unit tests cover the
validators + wiring.
