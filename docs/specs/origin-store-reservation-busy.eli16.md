# A busy database no longer looks like an error when retrying a held message — plain-English overview

## What this change is

When a Telegram message from the agent can't be delivered straight away, Instar keeps it in a small database and retries later. Before each retry, it "reserves" the retry, so two parts of the system can't both retry the same message and send it twice.

If another part of the system happened to be writing to that database at the same moment, the reservation would wait at most a fortieth of a second and then report an error, when the honest answer was simply "not this time, someone else has it". In practice nothing broke: the caller logged a warning and tried again on the next round. But it made one of our automated tests fail at random on busy test machines.

Now, if the database is busy, the reservation answers "not reserved", exactly as it does when another part has already reserved that message. Nothing changes about what gets sent or when.

## Safeguards

- A busy database is detected before anything is written, so no retry is counted that didn't happen.
- Any other kind of database error is still reported as an error.
- A new test recreates the busy situation on purpose: it fails without the fix and passes with it. The previously flaky test passed 15 times in a row under extra load.

## What a reader needs to decide

Nothing; it removes a random test failure and a misleading warning.
