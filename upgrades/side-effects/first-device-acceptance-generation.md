# Centralize the first-device generation key

The existing first-device route now gets its durable record key from the trust store. Concurrent candidates still compute the same key while a write is pending. A committed key is never reused. The store can recover the next generation from durable history without relying on a process-local counter.

This does not add any eligibility, remote enrollment or new record type. A future phone nomination must check eligibility and consume its proof at the same authority boundary. The existing first-device tests exercise two simultaneous local candidates and durable restart.

Independent review concurred. Selecting the key is not sufficient for future remote enrollment. Eligibility and nomination consumption must still be checked with the authoritative write.
