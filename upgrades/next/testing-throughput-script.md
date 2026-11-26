# Testing Throughput Report Without A Model

## What Changed

A new opt-in job builds the two-hour testing throughput report with a script instead of an AI session. It reads the verification journal, applies the same lane thresholds as the existing report, and saves a plain-text report in the agent's reports folder. It is off when installed and runs only when the scheduler's script runner is on. With the runner off it skips the run instead of starting a model. The existing AI-run report keeps its schedule.

## What to Tell Your User

Nothing changes on its own. There is now a way to produce the testing throughput report without using any AI usage, for when you want to switch it over.

## Summary of New Capabilities

An optional script-only version of the testing throughput report, shipped switched off.
