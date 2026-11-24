# Cross-machine messages reach the other machine, and say so when they cannot

## What Changed

- `MessageRouter` relayed cross-machine messages to `/messages/relay-machine`, a path no route serves; the receiving route is `/api/messages/relay-machine`. Every cross-machine send therefore got a 404 and was parked in the outbound queue as "machine unreachable". The sender now uses the real route (Machine-HMAC and the Ed25519 envelope signature, unchanged).
- A send to a machine that is revoked in this registry fails with its own reason and is never attempted. A send to a machine this registry does not list fails with a reason that says so.
- `POST /messages/send` answers 502 with `delivered: false`, `failureReason` and a plain `notice` when a cross-machine message could not leave the machine (it used to answer 201). Cross-machine results also carry `delivered: true` once the target accepted the message. Same-machine sends are unchanged. One degradation event is recorded per target per 30 minutes.

## Evidence

- On the rebuilt Mac Studio (2026-11-20) a send to the paired, online Mama PC was queued 84 ms later with "relay failed (machine unreachable)"; the outage hand-offs had to be posted into each peer's own server instead.
- New tests: 4 unit, 4 integration (three machines over real HTTP with real Machine-HMAC), 2 end-to-end on two booted servers. The end-to-end delivery test fails on the old path (`expected 'queued' to be 'received'`) and passes with the fix.

## What to Tell Your User

Messages I pass between my own computers now reach the other computer. If one of my computers does not know another one, I tell you that the message did not go through, instead of acting as if it was sent.

## Summary of New Capabilities

- Cross-machine `/messages/send` reaches paired machines.
- A failed cross-machine send answers 502 with a plain-language notice.
