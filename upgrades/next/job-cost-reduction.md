# Scheduled jobs run as scripts, with a session only when one is needed

## What Changed

- Seventeen shipped job templates (health-check, the feedback-factory jobs, llm-decision-grading, correction-class-review-backstop, feedback-factory-action-list and the ten that ship disabled) now carry a `runner: script` form: each run is a small Node script that prints one `JOB_RESULT ok|skipped|failed` line instead of starting a Claude session. Script runners ride the development-agent gate (`jobs.scriptRunners.enabled` omitted): the first development-agent wave runs only llm-decision-grading and correction-class-review-backstop as scripts. The other conversions keep their existing session path even with a saved opt-in until the new model-call audit is certified. On the fleet every converted job still runs its body as a session exactly as before. Rollback is live: `jobs.scriptRunners.enabled: false`, or a slug in `jobs.scriptRunners.disabledSlugs`.
- health-check works out a reason set on every run. Critical reasons (`disk-critical`, and `undelivered-reminders` from commitment-checkin-reminder) push on the same run; recoverable ones are a calm attention item that sends one message only after 6 hours or on recurrence.
- Supervision is layered (`docs/LLM-SUPERVISED-EXECUTION.md` gains a "Script job (layered Tier 1)" row). Jev triage, its outage replacement, model-written anomaly narration and the daily model review are built but code-gated inactive until benchmark and decision-quality audit coverage is complete; config cannot bypass the gate. Daily must-fail canaries still exercise the two active scripts against a loopback stub and must see them fail (one HIGH attention item per machine, `script-canary:<machineId>`, when any canary fails). Anomaly notices use deterministic text while the narrator is inactive.
- Measurement: job sessions are attributed per slug in the token ledger, `GET /jobs/cost` reports per-job tokens against a frozen 7-day baseline, `GET /jobs/triage` lists recent triage decisions, and a one-time rollout report goes to the Updates topic 7 days after a slug flips on a machine.
- The dashboard Jobs tab shows each job's runner, last result, 7-day tokens against the baseline and the last day's triage decisions. CLAUDE.md gains a "Scheduled jobs run as scripts" section for new and existing agents.

## What to Tell Your User

Most of my scheduled background checks start a full AI session even when there is nothing to do. Development agents now begin a staged move to small scripts: two deterministic jobs go first. The model-backed supervisor and busier checks remain off until every new Jev and LLM call can be benchmarked and reviewed for accuracy in bulk. A daily self-test checks that each active script can still report a real problem. Regular agents keep their current job execution until a later release.

## Summary of New Capabilities

- Script runners for converted job templates, with a live rollback switch.
- Daily must-fail canaries for active scripts. Jev triage, its outage-only replacement and the daily cross-job review are installed but inactive pending audit certification.
- `GET /jobs/cost`, `GET /jobs/triage` and `POST /jobs/script-supervision/pass`.
- A one-time 7-day rollout report per job and machine.

## Evidence

TypeScript build and lint passed locally. Focused unit tests passed for anomaly delivery, triage, outage backup, routes, config defaults, cost reporting, script trust and the five busiest scripts. Full suite, the 48-hour development-agent observation and the seven-day cost comparison remain rollout gates; they are not claimed as complete here.
