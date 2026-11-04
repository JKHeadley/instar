<!-- bump: patch -->

## What Changed

The Instar iPhone app can now show the agent's schedule, promises and machines natively. Three new read-only routes answer a paired owner phone (or the agent's token): `GET /mobile/jobs` (every job with its schedule in plain words, last run and outcome, next run, and whether it is late or failing, late or failing first, merged across the machines that answer), `GET /mobile/commitments` (open promises first with their due dates and what they are waiting on, then those closed in the last week) and `GET /mobile/machines` (each machine by name with a plain status line, load and Instar version). They are trimmed summaries of what the console's Schedule, Promises and Machines pages show: no job instructions, scripts, file paths, hostnames, machine ids, tokens or settings, and free text is secret-scrubbed and shortened. An MSP phone gets 403 `owner-phone-required`. The raw `/jobs`, `/commitments` and `/pool` routes stay closed to phones. A failed read records a `MobileOpsScreens.read` degradation instead of failing silently.

## What to Tell Your User

Once the app update with the new screens is on your phone, your agent's page in the app has an "Is everything up?" section: Schedule, Promises, and Machines and health. Late or failing jobs, overdue promises and machines that aren't answering are at the top, and you pull down to refresh. These screens only look; nothing on them changes anything. Only the owner's phone sees them.

## Summary of New Capabilities

- The owner's phone can read the agent's schedule, with late or failing jobs first.
- The owner's phone can read the agent's promises, open ones first with due dates.
- The owner's phone can see each machine's status and version, alongside the agent's health.

## Evidence

Unit tests cover both sides of every rule in the summaries (the 10-minute late line, placement before failures, a running retry after failures, older peers, replicated-promise staleness, the single-machine rule, stable row keys, scrubbing) and the owner-or-token check, including a missing principal failing closed. Integration tests go through the real device check: an owner phone is served with no prompt, path, hostname or machine-id fields; the token is served; an MSP phone, a phone demoted to MSP, a removed person's phone, a revoked, unsigned or tampered request, the notification token and a POST are all refused. A production-path test boots the server, pairs a phone, reads all three routes (a promise recorded through the real tracker appears) and confirms the raw routes stay closed to it.
