# Side-effects review for current single-member custody proof

The new read uses the established single-member topic ownership source. It checks the installed roster, instance lock, serving lease, and write admission both before and after confirming the active local record. Invalid epochs, unreadable records, and mismatched cached content return no proof. It does not establish ownership or write an ownership record.

This change exposes an internal read for the managed composition. No production consumer or user route is added. The packaged Stop fixture uses the actual identity roster and durable topic records at launch and callback time, with controlled lease, lock, and write-admission providers. The caller must bind the exact topic, launch, and enrolled epoch before relying on the read. It must order transfer and membership changes with the managed work claim.

## Second-pass review

**Reviewer:** solo_custody_reader_review, independent Instar second-pass agent

Concur with the amended read-only proof. It requires the live local authority, active durable ownership, and a positive safe integer epoch. A fresh-reader regression covers corrupted numeric evidence.
