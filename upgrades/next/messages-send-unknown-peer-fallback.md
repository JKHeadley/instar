# Cross-machine messages reach the other machine, route around a machine this one does not know, and say so when they cannot

## What Changed

- `MessageRouter` relayed cross-machine messages to `/messages/relay-machine`, a path no route serves; the receiving route is `/api/messages/relay-machine`. Every cross-machine send therefore got a 404 and was parked in the outbound queue as "machine unreachable". The sender now uses the real route (Machine-HMAC and the Ed25519 envelope signature, unchanged).
- A send to a machine this registry does not list is offered to up to four active paired machines; one that knows the target carries it exactly one hop (it joins the relay chain and re-signs). A send to a revoked machine is refused without a fallback.
- A cross-machine message for one of the agent's own named sessions is typed into that session on arrival, the same as a same-machine send.
- `POST /messages/send` answers 502 with `delivered: false`, `failureReason` and a plain `notice` when a cross-machine message could not leave the machine (it used to answer 201). Successful cross-machine results carry `delivered: true`, and `via` names the machine that carried a forwarded message. One degradation event is recorded per target per 30 minutes.

## Evidence

- On the rebuilt Mac Studio (2026-11-20) a send to the paired, online Mama PC was queued 84 ms later with "relay failed (machine unreachable)"; the outage hand-offs had to be posted into each peer's own server instead.
- New tests: 8 unit, 4 integration (three machines over real HTTP with real Machine-HMAC), 2 end-to-end on two booted servers. The end-to-end delivery test fails on the old path (`expected 'queued' to be 'received'`) and passes with the fix.

## What to Tell Your User

Messages I pass between my own computers now actually arrive. If one of my computers does not know another one yet, I route the message through a computer that does, and if no route exists I tell you instead of acting as if it was sent.

## Summary of New Capabilities

- Cross-machine `/messages/send` delivers to paired machines and into the named session.
- A target machine this one does not know is reached through a paired machine that knows it (one hop).
- A failed cross-machine send answers 502 with a plain-language notice.
