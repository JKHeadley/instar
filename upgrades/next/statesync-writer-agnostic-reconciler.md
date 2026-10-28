# Memory written by command-line tools now reaches your other machines

## Summary of New Capabilities

On an agent that runs on several machines with its memory stores switched on, a record written by a command-line tool (`instar knowledge ingest`, `instar relationship`, `instar user add`, `instar reflect`) or any other process now reaches the other machines' replication log within about ten minutes. Removing a relationship or a knowledge source with its own command replicates too. `GET /state/reconcile` shows what was copied, per store.

## What Changed

- A new background reconciler in the server reads the six file-backed memory stores (preferences, relationships, knowledge, users, learnings, action items) from disk every ten minutes and copies any record this machine's own replication log does not hold yet, through the existing emitter. It reads nothing for a store that is switched off, honours a store's dry-run, and skips a store whose file is carried by git on that machine.
- Copies it makes claim no "already seen" witness, so a genuinely different version on another machine is flagged as a conflict, never silently overwritten.
- `instar knowledge remove`, and relationship delete and merge, now write a small two-line deletion note (record key, time, the replication clock; no names) under `state/reconcile/intents/`; a deletion replicates only from such a note, never from a row simply going missing.
- The union reader no longer reports two byte-identical versions as a conflict, and closes such a conflict that was already open (recorded as "identical content", not as an operator decision).
- The preference replication hook now redacts credential-looking text, as its contract already said.
- New status route `GET /state/reconcile`; switch `multiMachine.reconcile.enabled` (default on).

## Evidence

Live trace on 2026-10-25 (all four of Echo's machines): the four stores the review flagged were empty everywhere, and the knowledge library had no in-server writer at all. Unit, integration and end-to-end tests drive the reconciler with a knowledge catalog written straight to disk on one instance and assert the record, and a command-line deletion, reach the other instance's replica stream, while a row removed by hand does not.

## What to Tell Your User

If I run on more than one of your machines, things I note from the command line, like a document added to my knowledge library or a person I record, now show up on my other machines within about ten minutes instead of staying on the machine where they were written. Nothing changes for agents that run on one machine.
