# Scheduled jobs can run on short job-mode instructions

<!-- bump: minor -->

## What Changed

Spec: `docs/specs/job-mode-instructions.md` (converged in 6 rounds, Codex GPT-6.2 Astra as the outside reviewer). Every scheduled job session used to load the agent's full CLAUDE.md, the AGENTS.md fallback and the auto-memory index into its first prompt. That prompt is written to the cache fresh on most runs. On Echo, a Haiku probe measured 80,442 first-turn input tokens. With the job-mode launch the same probe measured 29,516: 50,926 fewer, including 50,265 fewer cache-write tokens.

- `JobScheduler.spawnJobSession` resolves a job's instructions mode. The order is: an operator override `scheduler.instructionsOverrides["<origin>:<slug>"]`, then a jobs.json entry's `instructions` field, then the default. The default is job-mode only for a verified shipped job whose slug and body hash are on `SHIPPED_JOBS_REVIEWED_FOR_JOB_MODE`, which is empty in this release, so every shipped job stays full. An invalid value resolves that one job to full and is reported.
- For a job-mode job the scheduler renders the job-mode text in memory (`generateJobModeText`, about 3 KB, shared safety and disclosure clauses with CLAUDE.md) and passes it to `spawnSession({ jobMode })`.
- `claudeHeadlessExtraFlags` emits `--settings {"claudeMdExcludes":[CLAUDE.md, AGENTS.md, .claude/CLAUDE.md],"autoMemoryEnabled":false} --append-system-prompt <text> --session-id <uuid>` for Claude Code only, on both the headless and the rerouted interactive lane.
- Restricted spawns keep today's launch: confinement, confined tools, required tool confinement, no auth env, or a pinned session id. The session record carries `jobMode` (applied or the reason, the marker version and the text length, never the text).
- After the first job-mode run per job per (instar, Claude Code) version pair, the completion path reads at most 256 KB of the run's transcript. It records pass, fail or unknown in per-job, locked state under `.instar/state/job-mode-checks/`. A pass counts only after a one-time positive control for that Claude Code version shows loading is visible. A fail suppresses job-mode for that job on that machine until a probe passes after a version change or an operator clear.
- Rollout switch `scheduler.jobModeInstructions`: omitted means live on a development agent and dark on the fleet.
- New routes: `GET /jobs/:slug/job-mode` and `DELETE /jobs/:slug/job-mode-check`.
- `instar jobs migrate` carries an explicit jobs.json `instructions` value into the override map and journals it. Abandon removes only the overrides it created that are unchanged.

## What to Tell Your User

- **Cheaper scheduled jobs**: "My scheduled background jobs can now start with a short set of instructions instead of my whole instruction file. On a test run that cut about 60 percent of what each job reads before doing any work. I switch a job over only when its task doesn't need the rest, and I check that the switch really happened."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Job-mode launch for scheduled jobs | `scheduler.instructionsOverrides: { "user:<slug>": "job-mode" }`, or `instructions: "job-mode"` on a jobs.json entry |
| Job-mode status and check | `GET /jobs/<slug>/job-mode` |
| Clear a failed job-mode check | `DELETE /jobs/<slug>/job-mode-check` |
| Rollout switch | `scheduler.jobModeInstructions` (omitted = dev agent only) |

## Evidence

- `tests/unit/job-mode-instructions.test.ts` (28 tests): rendering and shared clauses, resolution order including body-hash review, a fork not inheriting an override, and invalid values; flags; transcript pass, fail and unknown, including a cut after a marker-bearing snapshot; check state for fail, suppression, single probe, unknown retries, generation discard on clear, and overlapping completions; positive control; migration carry and undo.
- `tests/unit/session-manager-job-mode-launch.test.ts`: real headless and rerouted argv carry identical flags, with the text as one argument; restricted spawns and Codex record why they skipped.
- `tests/unit/scheduler/job-mode-scheduler.test.ts`: overrides, the field, the gate off, and invalid values through `spawnJobSession`.
- `tests/integration/job-mode-routes.test.ts`, `tests/e2e/job-mode-instructions-lifecycle.test.ts`: routes behind auth; a tmux launch with a mock claude logs the job-mode flags, and the post-run check records unknown without suppressing.
- Probe measurements (Claude Code 2.1.330, Haiku 5.5): see the spec's Problem table.
