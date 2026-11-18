<!-- bump: patch -->
## What Changed

The Instar app can reach imported Claude and ChatGPT history: list, read, search, preview and apply, with the owner's own signed device only (not a browser device or a team member).

## What to Tell Your User

Soon you'll see your imported Claude and ChatGPT chats right in the Instar app, and be able to import from there.

## Summary of New Capabilities

- `/mobile/imported-history/{conversations,conversations/:ref,projects,search,preview,apply}` for the owner's app device.

## Evidence

`tests/unit/imported-history-device-rules.test.ts`, the browser and permission tests (72 in total), and the integration test's `/mobile` path.
