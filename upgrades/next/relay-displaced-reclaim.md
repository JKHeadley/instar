# A machine bumped off the agent relay takes it back

## What Changed

When a second connection using the same identity (usually the agent's own other machine) joined the Threadline relay, the first connection was displaced and stopped retrying for the life of the process. The relay's follow-up 4001 close then emitted a plain `disconnected`, so `/threadline/health` reported `disconnected, recoverable: true` for an agent that would never reconnect. Luna's (sagemind) laptop sat in that state for 40 hours on 2026-10-05/06, unreachable by every peer.

- `RelayClient`: a `displaced` frame now sets the state to `disconnected` at once, so the 4001 close no longer emits a masking `disconnected`. An `auth_error` frame now closes the socket, so the close handler schedules the retry instead of waiting on an open unauthenticated socket.
- `relayConnectionObserver`: a terminal `displaced` is no longer overwritten by a later plain disconnect; a successful `connected` clears it.
- `ThreadlineBootstrap`: on displacement the server reports a `Threadline.relay` degradation and, after `relayRearmAfterDisplacedMs` (default 15 min, 0 disables), reclaims the connection. Only the configured relay owner holds a relay client (a standby never connects), so reclaiming is the correct outcome. A failed first connect no longer drops the client: it keeps retrying with backoff instead of leaving the agent local-only until restart.
- `ThreadlineClient.reconnectRelay()` re-arms the existing relay client with its listeners intact.
- CLAUDE.md template + migration: "Is my own relay connection up? (displaced vs retrying)".

## What to Tell Your User

If another copy of me on one of your machines briefly takes my connection to other agents, I now say so and take it back on my own after a short pause, instead of going silent to other agents until someone restarts me.

## Summary of New Capabilities

- Displaced relay connections are reported as a degradation and reclaimed after a pause.
- `/threadline/health` reports `displaced` (not "recoverable") when that is the true state.

## Evidence

- `tests/e2e/threadline/RelayE2E.test.ts`: against a real relay, a displaced client reports `disconnected` at once and emits no follow-up plain disconnect, and `connect()` reclaims the connection (both fail without the fix).
- `tests/e2e/threadline/relay-displacement-reclaim.test.ts`: the production bootstrap path is displaced, reports the degradation, then reclaims the relay and the intruder is displaced in turn.
- `tests/unit/relay-connection-observer.test.ts`: a plain disconnect after a displacement does not mask it; a reconnect clears it.
