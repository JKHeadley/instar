# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A new built-in job, Guardian Activity Report (Script), counts the monitoring jobs' runs, failures and skips over the last 24 hours and saves a short local report under the agent's reports folder. It runs as a plain script, so it never starts a model and uses no tokens. It ships turned off (`enabled: false`) and only runs while script runners are enabled. While script runners are off it is skipped, never run as a model session. The scheduler's list of script-only report jobs is now a set that holds this job next to the existing testing-throughput report, so both are refused as model runs in the same places. The existing guardian review job is unchanged and still interprets findings.

## What to Tell Your User

Nothing changes for you yet. There's a new background report that counts how often my monitoring checks ran, failed or were skipped over the last day, and keeps that as a short note on this machine. It costs nothing to run because it never starts a model. It's turned off for now and only runs once script jobs are switched on. You don't need to do anything.

## Summary of New Capabilities

An optional, model-free activity report for the monitoring jobs, saved locally (off by default).

## Evidence

The script-runner unit test triggers the job with script runners off (skipped, no request made) and then on (one authenticated read of the guardian category report, a saved report with the expected totals, zero model spawns, zero tokens). The script's own test checks that the fixture totals match the summary and that impossible quota skips are rejected.
