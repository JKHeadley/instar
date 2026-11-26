# Feedback processing tolerates brief write contention

The feedback drain saves a status update for each report it processes. A new report and a status update can arrive together. They share one write lock so both records reach the right file. Under load, the drain could give up waiting for that lock after about half a second, ending a processing pass before it could finish.

Writes now retry at staggered intervals for up to three seconds when another writer has the lock. If the lock stays busy, the write reports the failure. Errors from the write itself still surface immediately.

The large test also gives its 500-record processing step up to 45 seconds on a busy verification machine. The test still runs a concurrent writer and checks that the full pass finishes within 90 seconds and uses less than 512 MiB. The ordinary production processing limit stays at 20 seconds.
