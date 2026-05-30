# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Fixed the root cause of the Framework-Onboarding mentor's Stage-A failures: the
compose prompt grew past tmux's command-line limit.** Stage-A spawns a session to
compose the next coaching message, passing the prompt — which embeds the whole
growing mentor↔mentee conversation — as a `tmux new-session` command-line
argument. tmux has a command-length limit (~12-16KB); once the accumulated
history crossed it, `tmux new-session` failed with "command too long", so the
step failed and the mentee got nothing (it worked early on, then broke as history
piled up). The conversation history fed into the Stage-A prompt is now bounded to
the most-recent ~6KB (with an explicit "older conversation elided" marker), so the
spawn stays under tmux's limit no matter how long the mentorship runs.

## What to Tell Your User

Only relevant if you run the (off-by-default) Framework-Onboarding mentor. Its
Stage-A step is now reliable for long-running mentorships — the prompt can't grow
past the limit that was making it fail. No behaviour change for short
conversations.

## Summary of New Capabilities

- `buildStageAContext` bounds the conversation history at 6000 chars (keeps the
  most-recent exchanges + a marker), keeping the Stage-A prompt under tmux's
  command-line limit — fixes the `stage-a-failed` root cause.

## Evidence

- `tests/unit/MentorStageA.test.ts` (+1): an ~80KB history produces a prompt
  under 12KB that keeps the most-recent exchange, carries the elision marker, and
  preserves the prompt structure. Full mentor/stage suite (114 tests / 9 files)
  green; `tsc` + `npm run lint` clean.
- Cold tmux repro: a 120KB argument to `tmux new-session` fails with "command too
  long"; 12KB passes — confirming the 6KB history cap is safely below the limit.
- Side-effects: `upgrades/side-effects/mentor-stage-a-prompt-bound.md`.
