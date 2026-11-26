# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Windows browser bridge now sends passwords and one-time links through a private pipe. The bridge no longer saves secret input or records the secret driver's raw output. The desktop driver can now list and target a page that has exactly one input field.

## What to Tell Your User

Windows sign-in repairs can pass sensitive input to the existing browser driver without creating a temporary input file. The same browser profile and foreground checks apply.

## Summary of New Capabilities

None. This repairs the existing Windows browser bridge.
