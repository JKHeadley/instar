# Claude Code paste submission

## What Changed

Instar waits one second between the end of a bracketed paste and its first Enter in a recognized Claude Code pane. The verifier checks the current input for the pasted marker, including markers split across lines. An earlier message above Claude's answer no longer triggers recovery in an empty composer.

## What to Tell Your User

A message pasted into Claude Code is less likely to sit waiting for Enter. An answered message can stay visible in the conversation without triggering an unsubmitted warning.

## Summary of New Capabilities

The existing recovery check can recognize a stranded multiline draft and stop once Claude consumes it.

## Evidence

Before the fix, a deterministic fixture missed the first submit at a 750 ms paste-commit threshold, sent five extra keys after an answer, and missed a stranded two-line marker. Tests exercise the same cases through SessionManager and the existing paste HTTP route. The threshold is synthetic. Live Claude timing remains unmeasured.
