# Side effects: resurfacer e2e waits for its first run

Test-only. tests/e2e/undated-action-resurfacer-lifecycle.test.ts waited a fixed 30 ms after boot and then required the first resurfacer run to have happened. On a loaded peer verifier (2026-11-04, PR 2707) the run came later, so the test failed with totalRuns 0; it passed when rerun on the Studio. The test now polls the status route every 100 ms, up to 10 s, until the first run is recorded, then makes the same assertions. No product code changes.

1-8: no runtime surface; rollback is a revert.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`, test-only, with a bounded wait.
