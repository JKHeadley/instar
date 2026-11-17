# Project apps: a stopped app says so

<!-- bump: patch -->

## What Changed

After the owner taps "Stop this app", the app's card leaves Needs-you and reads "Stopped by you. Turning it back on comes in a later update." Approving it again is refused, with plain words. The project's row and conversation strip show "<app> · Stopped" with no Open button, and an app not yet approved shows "Waiting for your approval". Summary counts past three are kept, not cut.

## What to Tell Your User

If you stop one of the apps I made for a project, the project's row now shows it as stopped, and nothing asks you to approve it again. Turning a stopped app back on comes in a later update.

## Evidence

- Whole unit lane green (69,810 tests).
- Integration and e2e tests for the project-app routes pass.
