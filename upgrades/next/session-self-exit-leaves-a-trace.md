<!-- bump: patch -->

## What Changed

A session whose process ended ON ITS OWN — no reaper, no operator, no kill — used to be recorded as a plain `status:'completed'` with no reason and NO reap-log row. The 2026-08-22 codex interactive death class was invisible in the records for exactly this reason; the charter that found the cause named it as a defect in its own right ("nobody can debug this from the records alone").

Now, on the monitor's vanish branch:

1. the session record carries `endedReason` — `process-exited`, or `process-exited-during-startup` when it died inside the first two minutes;
2. a `sessionExited` event is emitted and the server writes a reap-log row of a NEW type, `exited`, with the session's framework and uptime — served by the existing `GET /sessions/reap-log` without any reader change;
3. that row carries the LAST PANE TAIL the monitor saw. By the time the pane is gone there is nothing to capture, so the monitor now samples a dozen lines for sessions in their startup window (15s–120s, where silent deaths cluster) and the vanish path hands the last sample to the row. For today's bug the row would have read, verbatim, `Update available! … › 1. Update now … Press enter to continue`.

The tail goes through the SAME credential redactor the dashboard live-tail uses, INSIDE the log writer (no caller can write a raw tail), clamped to 12 lines / 1500 chars on write and re-clamped on read, with the redaction count recorded on the row. Samples are memory-only, bounded to young sessions, and evicted every tick for sessions no longer running. `sessionComplete` still fires for every existing listener.

## Evidence

- Tests: `recordExited` round-trips type `exited` + uptime + framework + tail (the read-side whitelist previously coerced any unknown type to `reaped` — a self-exit would have been relabelled a kill); credential-shaped material in the tail is redacted and counted; a 400-line dump is clamped to the last 12 lines; absence of a sample yields absent fields, not empty strings; `exited` and `reaped` rows are distinguishable in one log.
- Monitor tests: a young session that vanishes gets `process-exited-during-startup` + a `sessionExited` event carrying the tail sampled on the PREVIOUS tick (the pane is empty on the vanish tick — the exact situation the sample exists for); an old session gets `process-exited` with no tail; an INDETERMINATE probe stamps and emits nothing (the slow-tmux guard holds); `sessionComplete` still fires.
- Negative controls: removing the reason stamp + emit fails the monitor tests; removing `exited` from the read whitelist fails the round-trip tests (rows come back as `reaped`).
- Neighbouring suites green: session-manager terminate/behavioral/reap-detect/async-monitor, headless-spawn-reroute, reap-log lifecycle (e2e), reap-notify lifecycle (e2e + integration), session-lifecycle-reap-wiring (integration).

## What to Tell Your User

Nothing changes day to day. If a session ever dies on its own again, "where did my session go?" now has an answer in the records: a reason, how long it had been up, and the last few lines it printed — instead of a blank. Those lines are scrubbed for anything that looks like a credential before they are stored.

## Summary of New Capabilities

Self-exited sessions are now debuggable from the records: a reason on the session, an `exited` row in the shutoff log, and the last sampled terminal lines. No new surface to learn — it shows up where session ends already show up.

## Known Limits

A death inside the first 15 seconds, or one that lands between two monitor ticks, may carry no tail sample (the reason and the row are recorded regardless). Sessions past the 120-second startup window carry no tail by design. The sync legacy sweep `reapCompletedSessions()` still marks `completed` without a reason; it is superseded by the monitor loop and left untouched here. <!-- tracked: CMT-1044 -->
