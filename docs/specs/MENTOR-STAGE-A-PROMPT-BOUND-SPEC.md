---
title: Mentor Stage-A — bound the compose prompt under tmux's command-line limit
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Direct user directive (Justin, 2026-05-29, topic 13435): "lets fix this and
  make it more robust." The diagnosability fix (PR #544) surfaced the exact root
  cause this PR fixes: the Stage-A compose-session spawn failed because the
  prompt (the whole growing mentor↔mentee conversation) exceeded tmux's
  new-session command-line length limit.
eli16-overview: MENTOR-STAGE-A-PROMPT-BOUND-SPEC.eli16.md
date: 2026-05-29
---

# Mentor Stage-A: bound the compose prompt under tmux's command-line limit

## Problem (root cause, now confirmed)

The mentor Stage-A step composes the next coaching message by spawning a
tool-less Haiku session whose **prompt is passed as a command-line argument** to
`claude` via `tmux new-session`. The prompt is built by `buildStageAContext`,
which embeds `surface.threadlineHistory` — the **entire mentor↔mentee
conversation so far**. As that history accumulates, the command line grows; once
it crosses tmux's `new-session` command-length limit, `tmux new-session` fails
with `"command too long"`, the spawn throws, and the whole tick reports
`stage-a-failed` (visible now via PR #544's `lastResult.error`).

Confirmed empirically: a ~120KB argument to `tmux new-session` fails with
`command too long`; 2–12KB pass, 16KB fails — so the practical limit is ~12-16KB
(and the real command's env/flags prefix eats into that). This is exactly why the
mentor worked at 16:03Z (short history) and broke later (history accumulated).

## Design

Bound the conversation history in `buildStageAContext` so the assembled prompt
can never exceed tmux's limit:

- Cap `threadlineHistory` at `MAX_HISTORY_CHARS = 6000`. Everything else in the
  prompt (the fixed instructions + agenda + visible status + commitments) is
  small and not user-growing.
- Keep the **most-recent** `MAX_HISTORY_CHARS` of history (the recent exchanges
  are what matter for deciding the next action) and prepend an explicit marker
  noting how much older conversation was elided — never silently dropped.

This keeps the total prompt comfortably under the ~12KB practical budget (history
≤6KB + a few KB of fixed structure) with margin for the env/command prefix,
making the Stage-A spawn length-proof no matter how long the mentorship runs. The
two-hats isolation, the agenda-driven behaviour, and the prompt structure are all
unchanged.

## Convergence notes (adversarial self-review)

- *Does the bound lose context the mentor needs?* The mentor's job each tick is
  to decide ONE next action from the recent state + the agenda. The most-recent
  6KB of exchanges + the (separate, retained) agenda + visible task status carry
  that. Older middle history is the least relevant to "what's the next task."
- *Could a single recent message still blow the limit?* `MAX_HISTORY_CHARS` caps
  the history block regardless of message boundaries (a hard char slice), so the
  block can't exceed 6KB even if one message is huge.
- *Could the fixed parts (agenda) blow the limit?* The agenda is operator config,
  not user-growing; it is bounded in practice. The history was the only
  unbounded-growth vector.
- *Behaviour when history is small?* Unchanged — the bound only engages above
  6000 chars.

## Testing

- **Unit** (`tests/unit/MentorStageA.test.ts`): an ~80KB history yields a prompt
  under 12KB that (a) preserves the most-recent exchange, (b) carries the
  `older conversation elided` marker, and (c) keeps the prompt structure
  (`Conversation so far` / `Visible task status`). Existing buildStageAContext +
  full mentor/stage suite (114 tests / 9 files) stay green; `tsc` + lint clean.
- **At-scale (manual)**: reproduced tmux's limit cold (120KB arg → `command too
  long`; 12KB passes), confirming the cap is safely below it.

## Migration parity

Server-internal monitoring code, not an agent-installed file — every agent gets
the fix by running the new build. No PostUpdateMigrator entry required.
