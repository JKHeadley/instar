# Explain what happened after the serving machine restarted

If the Studio recovers its role after a planned restart, it must keep extending its serving lease. The backup can take over if it still sees the previous expiry pass. A successful restart alone does not tell us what happened in that first minute, because the machines can have different views of the same lease.

The serving machine now records the first three ordinary renewal attempts after it has confirmed its role. It records when each attempt began, when the old and new leases expire, and whether the renewal received confirmation. If the timer wakes to find that its lease already expired, it records that instead. Comparing those records with the backup's takeover record helps distinguish a late renewal from one the backup did not see. These are diagnostic records. The machines still use their existing lease and takeover rules.
