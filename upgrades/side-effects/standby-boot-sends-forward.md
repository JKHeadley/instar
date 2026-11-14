# Side effects: standby boot sends forward (dark pool, unsettled lease)

Change: `decideHolderForward` gains `hasPeer`; a dark pool with an unsettled lease answers `settling` (instead of `local`) when the machine registry lists a paired, unrevoked peer. Server wires `hasPeer` from the identity registry.

1. Over-block: none. The only new behaviour is a bounded settle wait (≤15 s) before an automatic send on a paired machine whose lease is unsettled, normally only the seconds after a restart.
2. Under-block: rows already held on the direct path stay held until their 6 h deadline; this change prevents new ones. A direct hold created by a lease move between the adapter decision and `authorize` is still possible (rare race).
3. Level of abstraction: the adapter's route decision is where the doomed direct send is chosen; fixing it there stops the hold being created at all.
4. Signal vs authority: no new gate. `authorize` keeps sole authority; this only chooses the route that can succeed.
5. Interactions: the settling path is the one a live pool already uses (forwardReplyToHolder: settle, forward, ladder, durable forward hold). If the lease settles to this machine, the existing OriginForwardSettledLocallyError makes the send local, as before.
6. External surfaces: up to 15 s more latency for an automatic message sent in the first seconds after a paired machine restarts. No change for single-machine agents.
7. Multi-machine posture: this is the multi-machine fix itself; behaviour is per machine, reading the replicated registry.
8. Rollback: revert the commit, or set the forward switch off (`messageOrigin.forwardToHolder.enabled: false`), which returns `local` as before.
