# Changes are confirmed even when the other machine is busy

<!-- bump: patch -->

## What Changed

When an agent runs on more than one machine, each change to the shared conversation history is confirmed by the other machines. A machine can be reached at several addresses (home network, Tailscale, tunnel). When the other machine took more than 5 seconds to answer, the sender tried the next address with the very same request. The receiver refused that repeat as a possible replay, so the answer was lost. On the page this looked like "Saved here. Waiting for <machine> to confirm." and then "changes are not being confirmed right now." Now an exact repeat of a request gets the same answer as the first copy, waiting for it to finish if needed. The work still runs only once, and a request with changed contents is still refused.

## What to Tell Your User

- **Accept all with several machines**: "Accepting changes no longer stalls at 'waiting for your other machine to confirm' when that machine is busy. The confirmation comes through even if the first way of reaching it is slow."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Confirmations survive a slow first address | Automatic |

## Evidence

Accept all round 4 (topic 144007): live run 2026-11-17 22:14-22:20Z stopped at 2 of 20; Studio refused `graph-peer-replayed` / `graph-bootstrap-peer-replay` next to M5 timeouts then status 403. Tests: `tests/unit/graph-peer-replay-guard.test.ts`, `tests/integration/graph-peer-replay-coalesce.test.ts` (one server on two real addresses with a 6.5 s answer).
