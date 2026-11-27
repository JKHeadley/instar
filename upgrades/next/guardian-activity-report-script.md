# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

A new built-in job, Guardian Activity Report (Script), counts the monitoring jobs' runs, failures and skips over the last 24 hours and saves a short local report under the agent's reports folder. It runs as a plain script, so it never starts a model and uses no tokens. It ships turned off (`enabled: false`) and only runs while script runners are enabled. While script runners are off it is skipped, never run as a model session. The scheduler's list of script-only report jobs is now a set that holds this job next to the existing testing-throughput report, so both are refused as model runs in the same places. The existing guardian review job is unchanged and still interprets findings.

## Evidence

The script-runner unit test triggers the job with script runners off (skipped, no request made) and then on (one authenticated read of the guardian category report, a saved report with the expected totals, zero model spawns, zero tokens). The script's own test checks that the fixture totals match the summary and that impossible quota skips are rejected.
