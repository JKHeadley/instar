# Side-effects review: relay-displaced-reclaim

## Change
RelayClient displaced/auth_error state handling; observer keeps terminal events; ThreadlineBootstrap reports a degradation on displacement and reclaims the relay after a pause (default 15 min); a failed first connect keeps the client retrying; ThreadlineClient.reconnectRelay(); CLAUDE.md template + idempotent migration section.

## Over-block / under-block
No gate added. The reclaim can only reconnect a machine that already held a relay client, i.e. a configured relay owner (relayEnabled and not relayStandby, and no listener daemon owning the relay).

## Self-action bound
Reclaim is a self-triggered reconnect. Bounded: at most one pending timer per process, one reclaim per displacement, minimum spacing of the configured pause (15 min default). If two machines are both misconfigured as owners they trade the connection at most once per pause each, and every displacement raises a degradation, so the misconfiguration is visible rather than silent. `relayRearmAfterDisplacedMs: 0` restores the pre-fix behaviour.

## Interactions
- Standby (`relayStandby`) machines never create a relay client, so they never reclaim (unchanged, instar#2122).
- Listener-daemon mode: the server does not hold the relay client, so no reclaim (unchanged).
- Keeping the client after a failed first connect: routes that check `relayClient` now see a client in `disconnected` state instead of undefined; sends while disconnected fail visibly as before, and the client reconnects when the relay returns.

## Signal vs authority
The degradation report is a signal only. The reclaim reconnects this agent's own connection; it takes no action on peers.

## External surfaces
`/threadline/health` relay.state reports `displaced` accurately. Agent CLAUDE.md gains one section (template + migration, content-sniffed).

## Rollback
Revert the commit, or set `relayRearmAfterDisplacedMs: 0` to disable the reclaim only.
