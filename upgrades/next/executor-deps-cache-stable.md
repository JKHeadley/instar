# Releases no longer force feedback workers to rebuild their dependencies

## What Changed
The feedback workers' private dependency cache was keyed on package.json and package-lock.json as written. Every release changes the project's own version in both files, so each release threw away the cache and forced a new install and native rebuild. Two attempts tonight ended when that rebuild hit its 20-minute limit; normal builds take about a minute and what hung was not captured. The cache key now ignores the project's own version. The base lint and smoke gate still reruns for each release. When dependencies really do change, a native binary of the same module version and Node ABI is copied from another finished cache instead of being compiled.

## What to Tell Your User
Feedback fix attempts no longer rebuild their tools after every release, which removes a step that was stopping them.

## Summary of New Capabilities
- The workers' dependency cache survives releases and reuses already-built native modules.

## Evidence
Unit: tests/unit/feedback-factory/execute-units.test.ts, both new tests failed with the old key and without the reuse. Live on Echo, 2026-11-07: attempts 8e9629fe:a5 and a6 ended deps-unavailable with "native rebuild failed (exit null, timed out)". The diff between releases 1.3.1702 and 1.3.1703 shows only version lines in package-lock.json.
