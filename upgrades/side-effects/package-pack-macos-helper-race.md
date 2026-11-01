# Side-Effects Review — macOS package completeness retry

**Version / slug:** `package-pack-macos-helper-race`
**Date:** `2026-11-01`
**Author:** Echo
**Second-pass reviewer:** not required (test-only retry bound)

## Summary

Two exact-commit full unit suites on M5 failed only `tests/unit/package-completeness.test.ts` while 54,070 unit tests passed. The failing `npm pack` call races temporary `instar-desktop-capture-test-*` helpers created and removed under `dist/native` by `MacDesktopHostCapture.test.ts`. A focused concurrent run exposed the exact npm `ENOENT` path. A third exact-commit full run still failed after increasing the retry bound: `npm pack --silent` returned empty stderr, so the classifier never saw `ENOENT` and could not retry. A forced-error probe confirmed that `--loglevel=error` preserves the path in stderr. This change uses that log level and extends only the named retry to at most 17 attempts (initial attempt plus 16 retries).

## Decision points and risks

- The retry still requires both `ENOENT` and `instar-desktop-capture-test-` in npm stderr. A missing real package asset, permission error, or other npm error fails immediately.
- `--loglevel=error` keeps npm's stdout as the tarball name while exposing errors to the classifier; it does not change package contents.
- The attempt count is fixed, so this cannot create an unbounded loop. Worst-case test latency rises when the exact helper race repeats; the normal path remains one `npm pack` call.
- This is test code only. No production source, package contents, config, API, or merge authority changes.
- A temporary helper could theoretically keep churning beyond the new bound; in that case the test still fails and preserves the release gate.

## Verification

The same package test passed in isolation on M5. A concurrent two-file run emitted `ENOENT` for two transient helper paths and still passed both files. A forced-error probe showed `--silent` returned empty stderr while `--loglevel=error` returned the expected `ENOENT` path. The corrected exact-commit full M5 suite must pass before merge; record that result in the PR.

## Conclusion

Tier 1 is appropriate: one existing test retry boundary, no production behavior, and bounded failure handling. The change prevents a known parallel-suite race without masking unrelated packaging errors.
