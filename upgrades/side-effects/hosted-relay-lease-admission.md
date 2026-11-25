# Side effects of optional relay lease admission

The dormant gate checks a holder's signature over the exact relay name, assignment, mesh lease, expiry and one-use socket challenge. The relay accepts only a lease that its trusted lookup independently verified. SQLite records the holder, highest epoch and current connection before admission returns.

- Lower epochs, different holders at the same epoch, reassigned names, expired leases, expired challenges and wrong machine keys fail closed. A valid same-holder reconnect supersedes the previous connection. Only the original in-process handle can authorize forwarding. A restart preserves the epoch floor and requires a fresh authenticated handshake.
- The owner-record and mesh-lease reader remains the authority. The future stream owner must reject stale connection IDs and close displaced streams. The gate opens no sockets and creates no owner authority.
- Multiple local workers need the same authoritative SQLite database. Multi-host deployment needs a shared transactional coordinator and displacement delivery across hosts. This implementation uses no remote SQLite mounts.
- Records contain the relay hostname, assignment, holder, epoch and derived connection ID. No private keys, signatures, challenges or content are stored. The durable high-water mark must be preserved on rollback and restart.
- No production service, listener or route is enabled. Direct agent reachability is independent.

Independent rereview concurred with commit-before-admission, in-process handle custody and restart fencing.
