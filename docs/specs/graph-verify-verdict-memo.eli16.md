# The conversation graph remembers which records it already checked (ELI16)

## What this changes

The agent keeps a signed record of every conversation, project and change, shared between the owner's machines. Before it trusts a record, it checks the record's signatures and proofs. That check is careful and takes a few milliseconds per record. With about 550 records, checking all of them takes 1 to 3 seconds on a busy machine.

The agent re-checks every record each time it rebuilds its trusted view, and during Accept all it rebuilds that view after every single save. In between two rebuilds usually only one record changed, so 549 of the 550 checks repeat work whose answer is already known. While they run, the server cannot answer anything else.

This change makes the agent remember each record's check result and reuse it, as long as nothing that check depends on has changed.

## What "nothing changed" means here

A remembered result is reused only when all of these are still the same:

- the record itself (any change to any part of it means a fresh check),
- which machine the record came from,
- everything the agent knows about deleted (erased) content, both its own list and the shared one,
- the agent's knowledge of removed machines and their records.

Records whose check depends on the time of day or on files on disk (a small group of special recovery records) are always checked fresh.

## Safeguards

During testing, every reused result is also checked fresh, and any difference fails the test. That catches a future change that forgets to say "something changed". There is also an off switch that turns the memory off without a new release. Nothing is saved to disk; a restart starts with an empty memory.

## What you need to decide

Nothing. This is part of fixing the server freezes during Accept all. It changes how often records are checked, not what counts as a valid record.
