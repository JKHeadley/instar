# Side-Effects Review — Pool dashboard streaming phase 2b (requesting side)

**Version / slug:** `dashboard-stream-phase2b-requesting`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

WebSocketManager routes a remote-machineId subscribe through a per-peer
PeerStreamProxy (phase 1) + a PoolStreamConnector (mint ticket via the phase-2a
mesh verb, open /pool-stream). Output fans back machine-tagged; input relayed;
honest error frames; transfer-staleness guard.

## Decision-point inventory

(1) Is a subscribe remote? → machineId present, !== self, AND session not
running locally (stale-hint guard). (2) Input on a remote sub → relayed
upstream (serving machine gates), never local tmux.

## 1. Over-block

A remote subscribe whose connector returns null (peer unreachable) surfaces
machine-unreachable — honest, not silent. A session that exists locally is
never routed remote (served locally) even with a remote hint.

## 2. Under-block

The browser client is trusted to supply the correct machineId (it rendered the
tile from /sessions?scope=pool). A wrong machineId routes to the wrong peer;
the serving peer only streams sessions IT runs, so a bad hint yields no output
(and the connector/ticket fail), not cross-talk. Local-existence is re-checked
server-side regardless of the hint.

## 3. Level-of-abstraction fit

Routing lives in WSManager.handleMessage beside the local path; the per-peer
link + reconnect/idle logic is the phase-1 PeerStreamProxy (reused, not
reimplemented); ticket-mint + ws-connect is the connector in server boot (it
owns meshClient + peerUrl). One streaming model; the remote path only swaps the
source.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new authority on the requesting side — it consumes the serving side's
authority (ticket, input gate). Errors are honest frames, never silent.

## 5. Interactions

- Local /ws path: unchanged for local sessions; only a machineId-tagged remote
  subscribe diverges.
- PeerStreamProxy (phase 1): the per-peer multiplex/reconnect engine, reused.
- Serving side (phase 2a): the connector consumes its mesh verb + /pool-stream.
- Client close: drops all remote subs from their proxies (no leak).
- pool-stream-ticket verb: the connector mints with a sentinel session ('*') —
  the ticket is per-connection, not session-bound.

## 6. External surfaces

No new HTTP/WS endpoint on the requesting side (it's a CLIENT of the peer's
/pool-stream). No new config (allowRemoteInput is serving-side). New AgentServer
options: poolStreamConnector + selfMachineId.
