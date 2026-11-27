# Placement shadow log drain

The window-aware selector records an already executed placement. Each record starts an asynchronous flush. The existing timer remains for retention and maintenance. Concurrent arrivals drain through one loop, in arrival order, while append and trim remain serialized. The loop clears the in-flight promise after every flush, including an empty same-day flush.

The server closes session and HTTP entry points before stopping the placement logger. Its existing shutdown deadline still bounds stalled disk operations. The logger clears any prior clean marker before appending and writes a new clean marker only after the buffer drains without a reported write failure. A process crash may still leave rows unwritten. The first subsequent unknown-loss marker represents that uncertainty. A record after the stopped boundary is ignored. Active producers must stop before this hook runs.

Account identity, selection, eligibility, credentials, session continuity and public schemas retain their existing authority. The stored file format and thirty-day retention are compatible with the old reader. Rollback restores the previous asynchronous buffer behavior and reads the same files. There are no extra network calls or synchronous writes.

The whole focused files passed 47 unit checks including the ratchets, nine HTTP checks, and three initialized-server checks. The second reader concurred on the exact source and test diff under handoff 4528d4ae.
