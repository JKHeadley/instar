# Fence journal reads while a decision's append is uncertain

The direct peer serve path checks the durable intent before and after reading Chief of Staff entries. A pending or unreadable marker produces explicit unavailability. Other journal kinds use their existing path. The local tail reader withholds entries at or above the pending sequence, and the complete read remains unavailable for this kind.

This only takes effect if the dark writer has persisted an intent. A peer cannot use an empty successful batch as the result of a pending decision. Ordinary replication resumes after exact reconciliation clears the marker. The marker cannot be cleared through this path. Lock replacement and cross-machine absence proof still constrain activation.

## Second-pass review

**Reviewer:** Independent journal safety reviewer.
**Result:** Concur for the dark checkpoint. The review identified a local reader that did not own the writer lock; the follow-up applies the same on-disk test to those reads and adds an observer regression.
