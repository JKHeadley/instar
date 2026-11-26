# Measured Lighter Start For The Session Continuity Review

## What Changed

The session continuity review can run an off-by-default trial that starts Claude without the project's integrations. Its six saved runs used only the local Skill tool and Bash, with a median first request of about 81,013 input tokens. Baseline runs keep the usual start. Treatment runs use an empty integration list and keep Bash and Skill. Missing prerequisites or an explicit job policy keep the usual start, and no second copy of the review is started. The job history shows which variant ran and its first measured request.

## What to Tell Your User

Nothing changes on its own. This trial measures how much AI usage the session continuity review could save before anything is switched over.

## Summary of New Capabilities

An off-by-default startup measurement for the session continuity review, shown in job history.
