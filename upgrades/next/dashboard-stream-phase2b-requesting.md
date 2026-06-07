# Pool dashboard streaming — phase 2b: the requesting side

## What Changed

The dashboard machine can now stream a session that lives on another machine. When a browser client subscribes with a remote `machineId`, the WebSocketManager routes it through a per-peer multiplexed upstream link (PeerStreamProxy from phase 1) instead of the local capture path: it mints a single-use ticket from the peer (the phase-2a mesh verb) and opens a real `/pool-stream` connection. Output frames fan back to the subscribed browser clients tagged with the source machine; input is relayed (the serving machine still enforces its own input gate); drops surface honest `peer-stream-lost`/`machine-unreachable` frames. A locally-running session is always served locally even if a stale remote `machineId` is hinted (transfer-staleness guard).

This completes the streaming engine end to end. The on-screen UI (clickable remote tiles + status badges) is phase 3.

## What to Tell Your User

Almost there — the machinery to click a remote machine's session and stream it is now wired both ends. The visible click-to-stream tiles land in the next (final) phase.

- audience: agent-only
- maturity: preview

## Summary of New Capabilities

- WebSocketManager routes a remote-`machineId` subscribe through a per-peer
  PeerStreamProxy; output fans back machine-tagged; input relayed; honest error frames.
- A `PoolStreamConnector` (in server boot) mints a ticket via the mesh verb and
  opens the upstream `/pool-stream` ws; injected through AgentServer.
- Transfer-staleness guard: a locally-running session is served locally despite a stale remote hint.

## Evidence

- `tests/unit/WebSocketManager.test.ts` (+7): remote subscribe opens a proxy +
  fans output tagged; self/local hints stay local; input relayed; drop →
  peer-stream-lost; remote unsubscribe cleans up.
- `tests/e2e/pool-stream-roundtrip-alive.test.ts` (new): two real WebSocketManagers
  + two http servers — a browser subscribe to a remote session streams the serving
  machine's output back over real sockets, machine-tagged.
