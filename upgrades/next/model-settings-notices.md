# Model settings notices

## What Changed
Sessions started with an explicit model choice no longer mistake that choice or inherited default drift for a failed settings change after a server restart. A real pending topic-profile mismatch is reported once across restarts, and busy retries do not add a redundant mid-task notice. Explicit later profile changes and protected-session instructions continue to work.

## What to Tell Your User
A session that started on the model you chose stays quiet. If a topic-specific settings change really needs a restart, you get one explanation while it waits for idle.

## Summary of New Capabilities
None; this corrects existing model-profile reconciliation and notification behavior.

## Evidence
Unit tests cover inherited default drift, explicit per-topic configuration, recovery and recurrence. The direct-spawn HTTP lifecycle covers explicit Codex choices with and without an existing pin and repeated busy mismatch boots. The self-action convergence ratchet bounds repeated notices independently of the boot horizon.
