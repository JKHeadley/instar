## What Changed

This adds an internal storage building block for Conversations. Large public records can be saved in small checked pieces instead of one giant text object. The visible feature is still being built; this change does not switch it on.

A saved piece must match its recorded contents and location. Missing, changed or incompletely saved pieces stop the read. A small range read can fetch one row without repeatedly loading the entire history, but the service must still check the full saved set before finishing a sensitive operation.

This storage code does not decide whether a record is public or whether an owner may make a change. Those decisions remain with the real service. It does not erase backups, promise permanently free disk space, reduce the amount of history kept, or remove an offline machine from its obligations.

## Evidence

Focused tests cover exact retries, interrupted writes, corruption, replaced files, missing indexes, directory durability and reads across page boundaries. Review caught a missing directory flush on cold reads; it was fixed and tested. Larger tests and the final Conversations integration are separate work, so these component results are not a deployment or recovery guarantee.
