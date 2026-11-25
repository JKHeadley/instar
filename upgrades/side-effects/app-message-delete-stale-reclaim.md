# Serialized stale server lock recovery

Stale reclaim uses a short SQLite immediate transaction as a host-local interprocess mutex. The current record and holder liveness are checked again inside it. A busy or broken mutex cannot authorize stale removal. Fresh publication retains its atomic no-replace behavior.

The adjacent SQLite file contains no application records and remains in place across shutdown. Do not remove or replace it while any contender may be using it. Existing state-directory and foreign-host checks still apply. Existing binaries that lack this mutex must not share the directory with a Delete-enabled process. Delete remains unmounted.

## 6b. Operator-surface quality

Two simultaneous restarts can recover a stale lock without one removing the other’s current ownership record.

## Framework generality

The lock belongs to the server and is independent of the agent harness.
