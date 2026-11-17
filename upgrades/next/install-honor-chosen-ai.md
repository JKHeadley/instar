<!-- bump: patch -->
## What Changed

`instar install --answers` now uses the AI named in the answers file's `door` even when a different AI is the only one found on the computer, or the installer runs inside one. Before, the Mac app's "Which AI account do you have?" answer was overridden by a Claude already on the Mac, so a ChatGPT pick produced a Claude agent with no sign-in step. An unknown `door` is refused with the valid names.

## What to Tell Your User

If you create an agent in the Instar Mac app and choose ChatGPT, you now get a ChatGPT agent and a ChatGPT sign-in, even if Claude is also on your Mac.

## Summary of New Capabilities

- The chosen AI wins over the detected one in `instar install --answers`.

## Evidence

Found in Justin's build 92 test on 17 November (picked ChatGPT, got Claude, no sign-in). tests/unit/install-flow.test.ts covers the pick winning over a single detected door and over the running harness, and refusing an unknown door.
