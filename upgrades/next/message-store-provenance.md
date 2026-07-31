<!-- bump: patch -->

## What Changed

New Telegram message-history rows now identify their structural origin as user input,
an agent's conversational reply, or automation. The value is set at the receive/send
boundary, survives the shared logger and cross-machine reply relay, and is never guessed
from message wording. Existing rows remain readable with provenance left unknown.

## What to Tell Your User

- **Accurate message accounting**: "My message history can now distinguish what I deliberately said from automated alerts and status traffic."

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Count conversational agent replies without prefix guessing | Read `provenance: "agent"` on new Telegram history rows |
| Exclude automated notices structurally | Read `provenance: "automation"` instead of matching message text |
| Preserve origin across machines | Automatic when a tokenless standby relays through the Telegram owner |

## Evidence

Focused unit and integration coverage exercises the real adapter, both JSONL writer modes,
the production reply route, the cross-machine relay body, and provenance-aware monitor
consumers. The final focused run passed 95 tests across seven files, including explicit proof
for all three provenance values, legacy omission, and automation-interleaved commitment pairs.
