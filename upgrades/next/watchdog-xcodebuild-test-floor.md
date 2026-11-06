<!-- bump: patch -->

## What Changed

The session watchdog now gives Xcode test runs the same protection as `npm test` and vitest. An `xcodebuild test` or `test-without-building` run, or `xctest` running a `.xctest` bundle, is no longer judged stuck or interrupted during its first 60 minutes. If its CPU time is still advancing, that extends up to 3 hours. Only the active Xcode's own binaries count: the one `DEVELOPER_DIR` or `xcode-select -p` points to, plus the `/usr/bin/xcodebuild` shim. `test` must also be the action word, so builds, archives, copied binaries and `-scheme test build` are judged as before. No threshold changed.

## What to Tell Your User

If you run iOS or Mac test suites through me, a long UI test run will no longer get cut off partway because it went quiet. Before this, a healthy 20-minute run could be interrupted with a third of its tests still to go.

## Evidence

fb-412e8332-ee1: at 2026-11-06T02:55:06Z the watchdog sent SIGINT to `/Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild test ...` after 1013 s. The run was healthy, and only 48 of 69 tests ran. With this change, `classifyTestRunnerProtection` returns `{protected: true, reason: 'test-runner'}` for that command at that age (tests/unit/session-watchdog-xcodebuild-floor.test.ts).
