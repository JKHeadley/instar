# Two red test shards on main: the plain version

## What this is

Since early on 2026-11-19, two of the four unit-test groups (shards) failed on every run of the main branch, on both Node versions. Neither failure came from a product bug. Both came from tests, and this change repairs those two test files only. The product is untouched.

## What was wrong

**Shard 3: a test counted another test's requests.** The conversations-page test file loads a fresh copy of the dashboard page for each test. Closing the test's fake browser window does not stop the copy that was loaded. If that copy was still partway through a request when its test ended (for example still signing it, which is slow on a busy machine), the request finished during the next test. It then went through the next test's pretend network, and that test counted it as its own. Several tests check that exactly one or exactly six history reads happened, so they saw two, three, seven or eight and failed. Alone, on a fast machine, the old copy always finished in time, so the file passed.

**Shard 4: a test left a file behind.** After the tests pass, CI checks that the tests left the checkout unchanged. One test loads a small Python program as a module. On the CI machines Python then saves a compiled cache folder (`__pycache__`) next to the program. That leftover folder tripped the check, so the shard failed even though every test passed. On our Macs Python keeps that cache somewhere else, so it never showed locally.

## What changed

- Every copy of the page now carries a number for the test that loaded it, and so does all the work that copy starts later. The pretend network ignores any request carrying an earlier test's number, so it never counts it and never answers it. The test also closes the page's message channel between tests, so an old copy cannot hear the next page.
- The Python program is now run with Python's "do not write the cache" switch, which another test in the suite already uses.

Nothing that the tests check was removed, loosened or skipped.

## What you need to decide

Nothing. This is a repair to tests, and reverting it restores the old behaviour exactly.
