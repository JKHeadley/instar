# Scheduled jobs run as scripts, with a session only when one is needed

## What Changed

- Seventeen shipped job templates (health-check, the feedback-factory jobs, llm-decision-grading, correction-class-review-backstop, feedback-factory-action-list and the ten that ship disabled) now carry a `runner: script` form: each run is a small Node script that prints one `JOB_RESULT ok|skipped|failed` line instead of starting a Claude session. A new shipped job, `script-job-supervisor`, runs the daily review. Script runners ride the development-agent gate (`jobs.scriptRunners.enabled` omitted): the first development-agent wave runs llm-decision-grading and correction-class-review-backstop as scripts, with the supervisor observing them; the other conversions wait for a 48-hour review. On the fleet every converted job still runs its body as a session exactly as before. Rollback is live: `jobs.scriptRunners.enabled: false`, or a slug in `jobs.scriptRunners.disabledSlugs`.
- health-check works out a reason set on every run. Critical reasons (`disk-critical`, and `undelivered-reminders` from commitment-checkin-reminder) push on the same run; recoverable ones are a calm attention item that sends one message only after 6 hours or on recurrence.
- Supervision is layered (`docs/LLM-SUPERVISED-EXECUTION.md` gains a "Script job (layered Tier 1)" row): the five `triage` jobs ask Jev whether a non-routine result needs a session; uncertainty requests a bounded investigator session, and a deterministic floor applies during outages. Haiku or Luna replaces Jev with a slower sample only while Jev is unavailable. Daily must-fail canaries run each script against a loopback stub and must see it fail (one HIGH attention item per machine, `script-canary:<machineId>`, when any canary fails); one daily review (`POST /jobs/script-supervision/pass`, component `ScriptJobSupervisor`) looks across all script jobs and raises LOW, advisory items only.
- Measurement: job sessions are attributed per slug in the token ledger, `GET /jobs/cost` reports per-job tokens against a frozen 7-day baseline, `GET /jobs/triage` lists recent triage decisions, and a one-time rollout report goes to the Updates topic 7 days after a slug flips on a machine.
- The dashboard Jobs tab shows each job's runner, last result, 7-day tokens against the baseline and the last day's triage decisions. CLAUDE.md gains a "Scheduled jobs run as scripts" section for new and existing agents.

## What to Tell Your User

Most of my scheduled background checks start a full AI session even when there is nothing to do. Development agents now begin a staged move to small scripts: two jobs plus their supervisor go first, and the busy checks wait for a 48-hour review. A daily self-test checks that each converted script can still report a real problem. Regular agents keep their current job execution until a later release.

## Summary of New Capabilities

- Script runners for converted job templates, with a live rollback switch.
- Per-run Jev triage for five jobs, an outage-only backup check at most every 6 hours, daily must-fail canaries and one daily cross-job review.
- `GET /jobs/cost`, `GET /jobs/triage` and `POST /jobs/script-supervision/pass`.
- A one-time 7-day rollout report per job and machine.

## Evidence

TypeScript build and lint passed locally. Focused unit tests passed for anomaly delivery, triage, outage backup, routes, config defaults, cost reporting, script trust and the five busiest scripts. Full suite, the 48-hour development-agent observation and the seven-day cost comparison remain rollout gates; they are not claimed as complete here.
