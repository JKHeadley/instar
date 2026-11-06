# Watchdog: leave Xcode test runs alone like other test runs (plain-English overview)

**What this is.** Each agent session has a watchdog. When a command has been quiet for a long time, the watchdog asks a judge whether it is stuck, and if the judge says yes it presses Ctrl+C on that command. Test suites are quiet for long stretches while they are working, so the watchdog already has a "test-runner floor": `npm test`, `pnpm test`, `npx vitest` and similar runs are left alone for their first hour. If they are still using CPU, that extends up to three hours.

**What went wrong.** The floor did not recognise Xcode. The iOS app's unit and UI test suite runs under `xcodebuild test` and takes 17 to 22 minutes. It prints nothing while a UI test is driving the simulator. On 2026-11-05 at 18:55 PST (feedback fb-412e8332-ee1), after about 17 minutes, the judge called a healthy run stuck and the watchdog interrupted it. 21 of its 69 tests never ran, and the result looked like a short pass rather than an interruption. Three earlier runs that day also ended with "Test crashed with signal kill". Their logs have rotated, so they are probably the same cause but that is not proven.

**What changes.** Xcode test runs now get the same floor, with the same bounds. Only real ones count. The program must be the active Xcode's own `xcodebuild` (the one `xcode-select -p` or `DEVELOPER_DIR` points to, or Apple's protected `/usr/bin/xcodebuild`), and `test` or `test-without-building` must be the action word, not the value of an option. `xctest` running a `.xctest` bundle from the same Xcode also counts. A shell that started such a run is protected while the run is underneath it, the same way a shell running `npm test` is.

**What does not change.** A bare `xcodebuild` name, a copy of the binary somewhere else, another Xcode install, `xcodebuild build` or `archive`, and `-scheme test build` are all judged normally. The one-hour floor, the three-hour hard bound, the judge, the hard ceiling and every other threshold are untouched, and the watchdog is not disabled. A run that is truly hung is still handed back to the judge once the bound passes, and the interruption is recorded and announced as before.

**Found alongside.** The feedback also suggests logging when the judge changes its verdict on the same process between polls. That is a separate improvement and is left in the feedback item.

**What to decide.** Nothing. This is a narrow fix that a revert fully undoes.
