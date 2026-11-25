# Check the current work record before continuing Codex

When Codex asks whether it should continue, Instar needs to check the worker and update the work record together. A separate pause request must not slip between reading the old record and saving an instruction based on it. The managed test runtime now reads the current record, verifies the Codex callback, and records any instruction within one local database transaction.

A pending or retired launch keeps its managed classification and gets no instruction. A pause that follows an issued instruction prevents the next one, while still permitting the first confirmation to be recorded. The test uses two database connections to verify the ordering. The switch remains off by default, and the work is still exercised through the disposable managed lifecycle rather than ordinary project launch.
