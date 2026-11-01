<!-- internal-only -->
# Bound tmux setup in GitHub CI

## What Changed

CI unit, integration, and E2E jobs use a runner's existing tmux when present. If tmux is missing, package update and install each have a three-minute timeout plus a ten-second forced-stop grace period. The workflow verifies `tmux -V` before any test runs. Required checks and test commands are unchanged.

## Evidence

At 2026-11-01 04:12 UTC, three active jobs were still in the old tmux install step after about three to five hours: main CI run 41248048362 integration, PR run 41250797327 unit shard, and PR run 41259245474 unit shard. Their GitHub job-step records had not reached `npm ci` or tests. The first PR run of this change will confirm behavior on a hosted runner.
