# Spend less time holding the feedback write lock

Feedback processing and ingestion sometimes write to the same source at the same time. A small lock file tells the two processes whose turn it is. Each write was flushing both the lock file and the feedback record to disk. On the laptop, flushing that temporary file took about 2.7 seconds across one 600-write test. That time is spent holding the lock, so another writer can be left waiting.

The lock still grants one process its turn and records the owner's process number. The process writes that number before entering the protected operation. The record and the files needed to recover feedback after an interruption are still flushed to disk. Only the extra flush of the temporary lock is removed. That shortens the time other writers wait. The existing retry budget and failure handling remain in effect, so the test still reports a failure when a writer cannot acquire the lock.
