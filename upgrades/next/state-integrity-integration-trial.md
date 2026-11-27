# Measured Lighter Start For The State Integrity Review

## What Changed

The state integrity review can run an off-by-default trial that starts Claude without the project's integrations. Its four saved runs used only Bash and the local Skill tool, with a median startup input of 81,013 tokens. Baseline runs keep the usual start. Treatment runs use an empty integration list with the same review, tools and schedule. Missing prerequisites keep the usual start, an explicit integration policy still wins, and no repair rule changes. The job history shows which variant ran and its first measured token event.

## What to Tell Your User

Nothing changes on its own. This trial measures how much AI usage the state integrity review could save before anything is switched over.

## Summary of New Capabilities

An off-by-default startup measurement for the state integrity review, shown in job history.
