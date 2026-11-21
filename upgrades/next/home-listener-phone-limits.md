# A phone at home is no longer refused for opening a screen's worth of connections, and refusals are recorded

<!-- bump: patch -->

## What Changed

The same-network (home) listener's connection limits were sized below what a real phone does: a live iPhone pairing over home Wi-Fi (Windows-made test agent) showed one app screen opening about 8 TLS connections at once, and the 6-open / 40-a-minute per-address limit (32 in all) refused the rest (iOS TLS error -1200). The limits are now 24 open and 240 new a minute per address, 64 in all. In WSL mirrored mode every phone reaches the agent from the Windows pass-through's one loopback address, so that address now gets the whole door (64 open, 960 a minute); the pass-through limits each real phone itself. The home listener also keeps a bounded refusal log (`state/same-network-refusals.json`, at most 300 entries, repeats coalesced, written at most every 2 seconds, mode 0600): connections dropped by a limit, failed TLS handshakes, and every request answered with 400 or more, with route (ids replaced), status, reason code, device id prefix and caller address only. `GET /mobile/same-network/refusals` (bearer, from this computer only) reads it, newest first.

## What to Tell Your User

- **Your phone at home connects reliably**: "A phone added at home on the same Wi-Fi could be cut off when an app screen opened several connections at once. That limit now fits a real phone, and when I do turn a phone away I keep a short note of why, so I can tell you what happened."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Home listener limits sized for a real phone (24 open, 240 a minute per device; 64 in all) | Automatic |
| Why the home listener refused a phone: route, status, reason code, device id prefix | `GET /mobile/same-network/refusals` from the agent's computer |

## Evidence

- `tests/unit/same-network-home-limits.test.ts`: both sides of every limit with the numbers themselves (24/25 open, 240/241 a minute with the 59 s and 60 s edges, the mirrored loopback door 64/65 and 960/961, another address in mirrored mode still 24), a busy phone of ten 12-connection loads a minute; the refusal log's route reduction, bound, coalescing, private file and restart; a real TLS listener records gate and route refusals, a limit refusal and a failed handshake once each. With the old 6/40/32 put back, 9 of its 19 tests fail (the limit tests).
- `tests/integration/same-network-refusals.test.ts`: over the real pipeline a stand-in phone's refused requests are recorded without the setup id, PIN, signature or full device id, and the route is bearer and this-computer only.
- `tests/e2e/same-network-first-phone-alive.test.ts`: the route answers on the production start path and the log survives a restart.
