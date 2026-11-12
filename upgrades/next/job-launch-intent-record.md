<!-- bump: minor -->
## What Changed

Scheduled jobs can now set an optional `thinkingMode` (`off`, `low`, `medium`, `high` or `max`) that says how hard the AI should think on each run. The scheduler translates it for the engine that runs the job: Claude Code gets an effort level, Codex gets its reasoning-effort setting, and engines without such a setting record `not-supported` rather than failing. A job that does not set the field launches exactly as before; a golden test locks today's start-up command for every engine.

Every scheduled model run (the scheduler's main path) now records what was actually launched: the engine, the settings that were applied or dropped (with the reason), and the engine's version. This is stored next to the existing framework and model fields in the run history, and it is built from the exact command handed to tmux, so the record cannot claim a setting the command did not carry. Script jobs and triage sessions carry no record, and if the final command does not carry what the builder reported, no record is written and an evidence error is logged instead.

- **Definition paths.** The field survives every way a job is defined or moved: jobs.json, AGENT.md job files, built-in jobs, job migration and portable bundles.
- **Evidence.** Each main-path run writes one `jobs.launchIntent` evidence row, and a dev-rung counter turns those rows into the spec's graduation floor.
- **Ratchet.** A new CI lint keeps engine-name checks outside the engine adapters from growing past today's count.
- **Awareness.** The CLAUDE.md template gains one Job Scheduler line, and existing agents receive it through an idempotent migration.

## What to Tell Your User

I can now run a scheduled job with lighter or heavier AI thinking, and every scheduled AI job run records which engine, settings and version were actually used. That lets us check whether lighter thinking saves usage on routine jobs without making them worse.

## Summary of New Capabilities

- Optional per-job `thinkingMode`, translated per engine.
- A launch record (engine, applied/dropped settings, version) on every scheduled model run.
- A CI ratchet on engine-name literals outside the adapters.

## Evidence

- 13 frozen acceptance test files (committed first, unchanged by the build): unit, integration (`job-launch-history`, `job-launch-definition-roundtrip`) and e2e (`job-launch-lifecycle`).
