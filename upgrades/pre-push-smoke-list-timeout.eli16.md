# Pre-push smoke tier: why it stopped running, and the fix

**What was wrong.** Before a push, instar runs a quick "smoke" check: it finds the tests affected by your change and runs only those. Since the host-wide test limit was switched from watch-only to enforcing on 2026-10-22, every push printed "SKIPPED … tests_run=0". The push still went through, so nobody saw that no tests had run.

**Why.** Finding the affected tests used `vitest list`. That command quietly ran a setup step that compiles the whole project (about two and a half minutes), then loaded every affected test file. For a change to a widely used file that is hundreds of files and six to nine minutes in total. The smoke script gives the listing two minutes, so it always timed out, and a timeout is treated as "don't know, skip".

**What changes.**
1. Listing tests no longer compiles the project. Only running tests needs that.
2. The smoke script first asks only for the affected file names, which takes about 35 seconds because no test file is loaded. If there are more than 80 files it says "too broad" straight away, as it was always meant to. Only a small set gets the full listing, which is then quick.
3. A push's tests now use the "small run" lane of the test limit (six at once) instead of the "full suite" lane (one at a time). The push config uses a single worker, so it is light. Without this, the fixed smoke check would have waited behind full test runs that hold the lane for about 40 minutes.
4. How long a test run waits for its turn is now set in the host's test-limit settings file (`acquireMs`, `acquireMsInteractive`), and the default goes from 2 minutes (10 for pushes) to 45 minutes. Before, a run that only needed to wait its turn failed instead.

**What stays the same.** The test limit stays on. The kill switch, the caps and the lane rules for other configs are unchanged. Environment variables still override the wait time.

**Measured.** A change reaching 591 test files: the listing went from timing out to a "too broad" answer in 35 seconds. A narrow change ran its 3 affected test files (74 tests) under the enforcing limit, and they passed.

**What to decide.** Nothing needs a decision. A related gap is reported separately: a change that reaches more than 80 test files still skips the local smoke check by design.
