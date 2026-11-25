# Check current ownership before a managed continuation

A saved ownership record can outlive the computer's permission to use it. The new server-side check confirms that the active record on disk agrees with the current roster, the running server's lock, and the serving lease. It returns the owner and ownership version only if those checks hold. Missing or damaged records do not provide proof.

The check is available to the upcoming managed project launch path. It adds no new worker and does not turn on continuation by itself. Tests cover an existing valid record, loss of the lease, loss of the server lock, enrollment of a second computer, and damaged records. The remaining wiring must connect this check to the exact worker and its saved claim, and prevent new work while an old worker could still continue.
