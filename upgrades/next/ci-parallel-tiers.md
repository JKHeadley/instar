<!-- internal-only -->
# Run independent CI test tiers concurrently

## What Changed

GitHub Actions starts integration and end-to-end tests alongside unit shards instead of waiting for all eight unit shards. Each job still runs its full test command, and all required checks still gate merging.

## Evidence

PR #2521 exposed the serial wait: its unit matrix had to finish before integration and E2E could start, while its independent Mac Mini full-suite check was already green. The CI workflow job definitions and test commands are otherwise unchanged. The first CI run on this change will confirm the new scheduling and full green result.
