# Refresh forwarding capability when the durable queue starts

## What Changed

When the durable inbound queue starts late in server boot, Instar now immediately refreshes the machine's pool heartbeat. Peers therefore see `ws11DeliverReceive:true` as soon as the receive path is actually live instead of retaining the earlier boot-time `false` advert.

## Evidence

- Added a wiring regression test that pins the heartbeat refresh immediately after successful queue construction.
- `tests/unit/ws11-dispatch-to-owner-wiring.test.ts`: 8/8 passing.
- TypeScript build passing.
- Live single-agent CROSS-MACHINE reproduction: both machines had live inbound queues while the pool advert remained false, causing a known-remote-owner message to queue without custody and fall through to a duplicate local spawn.

## What to Tell Your User

Cross-machine message forwarding becomes ready as soon as the receiving machine's durable queue starts, closing a short boot window that could make another machine treat it as unable to receive.

## Summary of New Capabilities

No new user-facing control. This makes the existing cross-machine forwarding capability advertise its live state promptly and honestly.
