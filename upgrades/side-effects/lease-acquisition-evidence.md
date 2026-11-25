# Record the lease view used for takeover

Once the existing store accepts an ordinary claim, the coordinator records one row in the existing local feature evidence log before the broadcast. The previous holder, epoch, expiry, nonce, observation age and existing decision come from the effective view used in the claim. The evidence field names distinguish the previous lease from the new epoch. Null means the value was unavailable.

The feature evidence logger bounds and scrubs each record and handles I/O failures. The write adds one local append per successful claim. It does not create a claim or bypass an election check. Consent-based handback and failed compare-and-set attempts are outside this change. Rollback removes the evidence write and needs no migration.
