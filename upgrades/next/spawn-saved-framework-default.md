# Saved model defaults apply to spawned sessions

## What Changed
Sessions spawned without an explicit model now use the saved default for their resolved framework, matching interactive sessions. Explicit model choices, including the balanced tier used by internal judges, retain their existing behavior. No saved default retains the existing launcher fallback.

## What to Tell Your User
Your saved default model now applies when a new session is spawned without a model choice.

## Summary of New Capabilities
None — this corrects existing saved-default behavior.

## Evidence
Regression tests at the SessionManager launch boundary reproduce omitted Codex and Claude defaults being skipped before the fix. They verify launch arguments and persisted model metadata after the fix, explicit raw models and balanced, and the no-default fallback. Reference: fb-d4cae51f-16b, topic 10000002384.
