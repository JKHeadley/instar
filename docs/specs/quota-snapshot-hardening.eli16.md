# Quota Snapshot Hardening — ELI16

A quota reading is like the fuel gauge in a parked car: the number may have been
correct when it was measured, but it becomes less trustworthy as time passes.
Instar used to show the last number without clearly saying when that number was
old. Quota reads now carry a `staleSnapshot` flag and the age of the reading.
After two expected polling intervals (30 minutes), the flag becomes true.

There was a second ambiguity in the credential reader. A missing credential and
a credential file containing broken JSON both became the same empty result.
Missing data can be retried, but broken credential data needs a fresh login.
The reader now reports that malformed case with a safe reason code, and the
quota poller changes the account to `needs-reauth`.

The broken credential text itself is never returned or logged. Only the
classification leaves the credential boundary.
