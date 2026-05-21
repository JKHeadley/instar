# Convergence Report — Wizard input validation + spinner

## ELI10 Overview

v1.2.13 shipped the hybrid wizard — instar's own state machine
driving conversational setup, with Codex generating warm narrative
for each step. Justin's first real install test on Codex caught a
broken UX: during the multi-second Codex narrative call, the
terminal looked frozen, so he pressed Enter again. The extra Enter
buffered in stdin and was eaten by the next prompt as an empty
submission, which the wizard silently defaulted to "agent". The
user ended up with an agent named "agent" without ever typing a
name.

This PR fixes both halves of the failure: a visible "composing…"
spinner during Codex calls (so the terminal doesn't look frozen),
and per-state input validators that catch empty/garbage submissions
and re-ask with a friendly nudge. The state machine is otherwise
unchanged — same flow, same Codex narrative, same Claude path.

## Original vs Converged

The fix went straight to the right shape. The only alternative
considered:

- **Drain stdin between turns**: discussed, rejected. Reliably
  draining stdin across platforms (especially during a long-running
  spawnSync child holding the terminal) is finicky and platform-
  specific. The validator + spinner combo addresses the
  user-visible failure mode without needing it.

The "intelligent recovery" angle Justin raised ("an intelligent
system would recognize the user hadn't actually entered a name")
is solved by the validator pattern. The validator IS the
intelligence: it knows what a valid answer looks like and what a
"this slipped through accidentally" answer looks like. The state
machine stays deterministic; the validator layer adds the
behavioral intelligence to input handling.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's real-user log | 2 | added validators + spinner |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Invisible latency window triggers buffered-Enter.**

- Severity: high (real user hit it on first install).
- Resolution: `startSpinner` utility renders a braille animation
  during codex calls. No-op on non-TTY.

**Finding 2 — Empty input accepted with silent default on required
fields.**

- Severity: high (silent acceptance of bad input is a UX trap).
- Resolution: `validate` field on NarrativeState. `requireNonEmpty`
  validator rejects whitespace-only submissions with a friendly
  reprompt that explicitly mentions the buffered-Enter footgun.
  Wired on agent-name, agent-role, user-name. The defensive
  fallback (`answer.trim() || 'agent'`) is removed; the validator
  guarantees `next` sees only valid input.

**Finding 3 — Choice prompts accepted garbage with silent
default-to-skip.**

- Same shape as Finding 2 but on choice prompts.
- Resolution: `requireChoice` validator wired on welcome, autonomy,
  messaging.

## Convergence verdict

Converged at iteration 2. Two utility additions (validators +
spinner); one new optional field on the state-machine API; bounded
retry loop in the driver. No abstraction creep. 26 unit tests cover
the validator contract and state wiring. Spec is ready.
