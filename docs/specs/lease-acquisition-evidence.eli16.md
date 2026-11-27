# Explain why a backup took over

When a backup machine starts serving, its local record should explain what it knew at that moment. The record identifies the previous lease the backup saw, including when it was due to expire, and why the election allowed the backup to claim the next lease. The backup writes the record after its local claim is accepted, before it waits for other machines to hear about it.

This matters because the Studio can confirm a renewal with one machine while another still sees an older expiry. The backup's record lets us compare those views and tell an expired lease from a missing observation. The change records the decision the election already made. The machines continue to enforce their current rules for who can serve, and names or timestamps in the log cannot grant authority. The record contains lease coordinates and no message content or signing secrets.
