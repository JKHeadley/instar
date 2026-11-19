# Desktop helper tests no longer fail on a busy machine

<!-- bump: patch -->

## What Changed

The Mac remote-desktop code waits a fixed time for its small native helper at each step: 2 seconds for an ordinary command, 4 seconds for a frame. The unit tests stand a Node script in for that helper, and on a busy test machine a Node process can take longer than 2 seconds just to start. The test then failed with a timeout although nothing was wrong, and it failed unrelated changes in the merge line.

Every helper wait now goes through one small module, `src/core/MacDesktopHelperBudget.ts`, which multiplies the wait by a process-wide scale. The scale is 1 unless something sets it, so a running agent waits exactly as long as before. The test setup file sets it to 10 for every test file. The scale can only lengthen a wait: a value below 1, or one that is not a finite number, is refused, and anything above 20 is held at 20.

## What to Tell Your User

- **Remote desktop**: "Nothing changes for you. This only makes my own tests steadier on a busy machine."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| None for users or agents. Test runs stretch the Mac desktop helper waits tenfold | Automatic in the test suite; a running agent keeps the same waits |

## Evidence

- Unit: `tests/unit/mac-desktop-helper-budget.test.ts` (scale 1 gives 2,000 ms for an ordinary command, the suite scale is 10, invalid values fall back to 1, values above 20 are capped, no production file sets the scale).
- Unchanged and passing: `tests/unit/MacDesktopHostCapture.test.ts`, `tests/unit/MacDesktopHostIdentity.test.ts`, `tests/unit/desktop-displays.test.ts`, `tests/unit/desktop-locked-proof-fixes.test.ts`, `tests/unit/DirectDesktopAccess.test.ts`.
