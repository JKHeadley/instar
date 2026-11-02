<!-- internal-only -->

## What Changed

The macOS desktop package CI job now runs the guided setup production-boot E2E file after building. This preserves automated Mac coverage after the test was correctly made platform-specific. The same test file checks that native Linux reports unsupported setup and refuses to write configuration. The Windows package smoke test retries only a temporary connection-unavailable response with a fresh signed nonce, bounded to five attempts. Two test-only timing races and the current-main documentation coverage floor are also repaired. Runtime product behavior is unchanged.

## Evidence

The exact revised head passed 55,509 unit tests with zero failures. Its macOS E2E command passed four tests with the Mac setup case included and one Linux-only skip. The predecessor code-identical head passed local integration, GitHub CI, and independent unit/integration/E2E verification with zero failures. A separate second-pass reviewer caught the Mac CI coverage gap and concurred after the workflow fix and review-artifact correction. New-head CI and independent verification remain required after publication.
