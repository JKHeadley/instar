# Measured Lighter Starts For Memory Hygiene And Development Reviews

## What Changed

Two off-by-default measurements for scheduled reviews that start AI sessions:

- The memory hygiene review can run a trial that starts Claude without the project's integrations. Its saved runs used only Bash and the local Skill tool. Baseline runs keep the usual start, treatment runs use an empty integration list, and both keep Bash and Skill. An explicit job policy, a missing skill, a constrained tool list or an unsupported launcher keeps the usual start. The job history shows which variant ran and its first measured request.
- The development review can record whether it would have had any work to do. On November 22 it started a session with an empty job list and used 331,137 tokens. The review still runs as usual. The history only records "would skip", "would run" or "unknown".

Job history now links each job transcript to its scheduler session, so these numbers are available even with the unified usage ledger off.

## What to Tell Your User

Nothing changes on its own. These trials measure how much AI usage two routine reviews could save, before anything is switched over.

## Summary of New Capabilities

Off-by-default startup measurements for the memory hygiene and development reviews, shown in job history.
