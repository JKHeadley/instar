## What Changed

Feedback writers spend less time holding their shared lock. They still flush the actual feedback record and recovery data to disk.

## What to Tell Your User

Feedback processing and ingestion can spend less time waiting for each other when they run together.

## Summary of New Capabilities

Feedback can release its temporary write lock sooner.
