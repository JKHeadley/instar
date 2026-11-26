# Confirm the current lead can survive a planned restart

A planned restart can leave the preferred machine offline long enough for another machine to become the lead. While the new lead settles, Telegram replies, verification jobs and feedback processing can be delayed. Echo already has a way to ask a peer to confirm a longer lease before a planned restart. That confirmation needs to match the exact restart request and the lease renewal that will survive the restart.

This checkpoint gives the existing lease authority a way to answer that question. It checks the current holder and lease generation, matches the request, and requires enough time remaining for the boot. A later renewal without its own confirmation leaves the answer pending, even if an earlier renewal in the same restart episode had succeeded. The future supervisor wiring must check the answer again immediately before it stops the server.

The new check starts off. It does not change how crashes or explicit role loss work, and it gives no machine permission to take the lead.

The supervisor can now wait for this evidence before it consumes a planned restart request. A decision about an earlier request cannot clear a newer request. The installed supervisor still needs a trusted connection to the running server before this is enabled.
