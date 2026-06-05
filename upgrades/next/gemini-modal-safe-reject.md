# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Prompt Gate now recognizes the exact Gemini CLI package-runner install prompt
that blocked the live mentorship cycle: an `instar` package version followed by
`Ok to proceed? (y)`. That narrow prompt is answered with the highlighted
default, so the agent can continue through its own Instar CLI command without a
manual Enter press. Arbitrary package installs are not auto-answered.

Prompt Gate also recognizes Gemini CLI execution-approval modals, but with the
opposite policy. Execution approvals ask whether model-proposed command text may
run. This change adds no approval path. When the known modal shape includes the
reject option, Prompt Gate chooses that reject option and records the rejected
command text in the server log plus an observable Prompt Gate event.

## Evidence

Not reproducible in a live dev shell without driving Gemini into the exact
interactive modal, but covered by deterministic unit fixtures from the captured
terminal shapes:

- package-runner install prompt for `instar@1.3.270` auto-dismisses with Enter;
- arbitrary package-runner install prompt does not auto-dismiss;
- execution-approval modal with highlighted Allow once still auto-rejects;
- rejected execution command text is carried in the detected prompt metadata.

## What to Tell Your User

Gemini can now get past the specific Instar package install prompt that was
blocking mentor cycles. If Gemini asks to run an arbitrary command, Instar will
not approve it automatically. It rejects the known approval prompt and leaves a
visible record of the command it refused, so the mentor can see why the task
changed course.

## Summary of New Capabilities

- Auto-answer the narrow Gemini package-runner install confirmation for Instar
  package versions.
- Auto-reject Gemini execution-approval modals with an explicit reject option.
- Record execution auto-rejects visibly so mentor diagnosis does not depend on
  guessing from a stalled terminal.

