<!-- bump: patch -->
## What Changed

Telegram topic names now reach every machine of the agent (spec `docs/specs/topic-name-replication.md`, closes CMT-2095, Studio outage ledger N40).

- Only the lead machine polls Telegram, so only it learned topic names and renames; when it died, standbys showed "Name not available". Names now ride a new replicated kind `telegram-topic-name-record` (store `telegramTopicNames`) on the existing WS2 record path. Each machine applies the winning name to its topic registry and keeps a copy in its own journal, so a rebuilt machine learns every name from any survivor.
- Ordering: a rename beats a name held from before the update, which beats a creation name; then Telegram's own time and message order. A late rename notice or a message quoting the topic's original name never undoes a newer rename. A name held from before only fills a blank on another machine; the lead's ones rank above the standbys'.
- Session binds keep the replicated name; the session label follows a rename on standbys too.
- Unsent names are retried while the server runs (paced batches under the journal's rate cap), not only at restart.
- On wherever the coherence journal runs. Off switch: `multiMachine.stateSync.telegramTopicNames.enabled: false` (read at boot). A machine on an older build ignores these records.

## What to Tell Your User

If your agent runs on more than one computer: conversation names and renames now show correctly on every computer, and they are no longer lost when the main computer goes down. Nothing to do.

## Summary of New Capabilities

- Telegram topic names are shared across the agent's machines (new journal kind `telegram-topic-name-record`; off switch `multiMachine.stateSync.telegramTopicNames.enabled: false`). No new routes.

## Evidence

- Unit: `tests/unit/telegram-topic-name-replication.test.ts` (validator, total-order fold, local evidence stamps, out-of-order renames through the adapter, fills, lead backfill once, deferral of future rows, crash repair, final refusals, drain pacing, wiring), `tests/unit/topic-names-through-lifeline.test.ts`, `tests/unit/CoherenceJournal.test.ts` (kind tables).
- Integration: `tests/integration/telegram-topic-name-replication.test.ts` — three machines over real journals: a rename reaches B's registry file, B carries it, a rebuilt C learns it from B alone; old renames and creation names never win; a standby upgrading first cannot impose stale names.
- E2E: `tests/e2e/telegram-topic-name-replication-alive.test.ts` — production wiring: one record per captured name, restart sends nothing again, kill switch emits nothing; server.ts wiring checks.
