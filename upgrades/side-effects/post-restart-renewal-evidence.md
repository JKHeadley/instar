# Record early lease renewals after a planned restart

After a confirmed boot reclaim this process records the epoch, nonce, expiry and lease lifetime. Up to three ordinary renewals record start, elapsed time since reclaim, previous and proposed expiry, and medium confirmation. Recording the start separately preserves evidence when the renewal does not return. If the timer finds the same lease already lapsed, it records that skip and closes the trace.

All rows use the existing bounded feature evidence log. The records carry no lease signatures, message bodies or credentials. Confirmation means the existing medium accepted the renewal. It does not establish that every standby saw it. The trace adds bounded local writes on the observed paths and leaves election, renewal, retry and handback decisions to the existing code. Rollback removes the logging and requires no data migration.
