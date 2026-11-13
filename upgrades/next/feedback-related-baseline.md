## What Changed

The feedback executor's last check runs the tests related to a fix's changed files inside its sandbox. That sandbox refuses a local `listen`, so every test that starts a server failed there no matter what the fix did, and the attempt was thrown away. When the related tests fail, the executor now re-runs only the failing test files on a fresh clone of the unchanged code, in the same sandbox. If every failure the fix's run reported is also reported there, the fix added none: the check counts as "don't know", the pull request says so, and the full CI test run must still pass before merge. A failure only the fix's run has, a failing file the unchanged code lacks, a failure with no file named, or an unchanged-code run that hits its limit still stops the fix. Each failed or "don't know" related run now records its failing test names in the audit log.

## Evidence

Reproduction on the operated Studio, 2026-11-11 to 11-12: of 25 recent attempts, 9 ended `gate:related-tests` and none reached a pull request. The last recorded check failure reads `Serialized Error: { code: 'EPERM', errno: -1, syscall: 'listen', address: '127.0.0.1' } ... originated in "tests/unit/outbound-advisory-routes.test.ts"`; the sandbox settings set `allowLocalBinding: false`, which denies that bind. The other eight left no detail (only the reason was logged), which this change also fixes. After (unit level, tests/unit/feedback-factory/execute-service.test.ts): the same EPERM output at head and at base reaches `pr-open` with "also happens on the unchanged code" in the PR text; a base run that passes, a file missing at base, an unnamed failure, and a base timeout all stay `gate:related-tests`.

## What to Tell Your User

Automated fixes were being thrown away because a test that can't run in their locked-down sandbox failed, even though the fix had nothing to do with it. Now a failure that also happens without the fix no longer counts against it. Every fix still has to pass the full test run before it merges.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Related-test failures compared against the unchanged code | Automatic |
