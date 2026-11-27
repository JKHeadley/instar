<!-- bump: patch -->

## What Changed

Planned restart admission reports when the measured restart window exceeds what peers allow. Restart requests preserve a pending update ahead of an ordinary restart, and preserve ordinary intent ahead of a role change that can be withdrawn. The restart consumers retain the current request when a check fails unexpectedly.

## What to Tell Your User

None — internal restart safety. Admission remains off until explicitly enabled through the existing rollout.

## Summary of New Capabilities

None — internal restart safety.
