# Shipping closed-episode reconciliation

Tier 1. The watcher checks up to four gave-up episodes missing from normal discovery per refresh. The direct GitHub read is authoritative for terminal state. Missing from discovery, read errors and unknown results carry no authority to clear a record. An error cannot authorize a merge.

The normal tick and lease retain ownership of the state update. A lost lease discards the results. Armed episodes keep their existing reconciliation path. A completed PR's retry episode is removed from the live state after confirmation and its terminal status is recorded in the audit.

Rollback reverts the watcher change. Existing state remains readable. A full verification run is required before merge.
