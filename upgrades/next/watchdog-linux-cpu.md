<!-- bump: patch -->
## What Changed

- **The Linux CI failure of the "a working test run is spared past the hour mark" end-to-end test is explained and closed for the right reason.** On Linux, `ps` shows a process's title, and npm sets its title twice: bare `npm` as it starts, then `npm test` about a second later, once its config has loaded. macOS `ps` never shows the title, so it always reads the original command. The test aged the clock to 61 minutes and polled immediately, and on Linux the first poll could land in that one-second `npm` window. A bare `npm` names no test run, so the watchdog's stuck check was asked to judge it. The test now waits until the npm row reads as a test run (checked with the watchdog's own classifier) before it polls.
- **The product was not wrong on Linux.** The watchdog never judges a command younger than 3 minutes, so a real `npm test` it ever judges has long since set its `npm test` title, which the existing argv rules match. The test comment added on 2026-10-22 said a Linux npm row "cannot grow past" `npm` and is never protected by itself. The same CI run disproves that: the next test in the file read `npm test` from the same process, and the comment is corrected.
- Unit coverage now pins the two platform shapes (`node /usr/local/bin/npm test --silent` on macOS, `npm run test:unit` as a Linux title) and the startup-window `npm` shape (not a test run).

## What to Tell Your User

Nothing changes for you. A test failure on our Linux build machines came from the test checking too early, not from a fault in how your agent spares long test runs. Long test runs are spared the same way on Mac and Linux.

## Summary of New Capabilities

None. This is a test-only correction plus added unit coverage.

## Evidence

- CI runs 39753464476 and 39767066373 (E2E Tests, Linux): the failing judge prompt shows `Command: npm`, `commandChars: 3`. In the same run, the next test in the file logs `stuck command (3660s): npm test` for the same fixture process. So the title grew after the first poll.
- npm 11 source: `lib/cli/entry.js` sets `process.title = 'npm'`; `lib/npm.js` (`npm:load:setTitle`) later sets `['npm', ...positional args]`, after config load and the cache/log mkdirs.
- Local (macOS): `tests/unit/session-watchdog-test-runner-floor.test.ts` passes (43 tests).
