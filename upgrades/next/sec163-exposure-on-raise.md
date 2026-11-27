# Switching public exposure on through the API needs the owner's approval

<!-- bump: patch -->

## What Changed

SEC-163. The trust-raise check now treats switching public exposure on as a loosening. That covers switching the public tunnel on, joining the agent network (the relay), and making the agent more visible on it. With only the API token, `PATCH /config` answers `403 operator-approval-required` and writes nothing. The connect-to-network route and the agent-network tool's enable action no longer write the relay switch themselves; they open the owner's approval card. The card can carry only the tunnel and relay switches, never an address or token. Switching exposure off is unchanged, and so are setup flows, which write the settings file directly.

## What to Tell Your User

- **Joining the network asks you first**: "I can no longer put myself on the internet or join the agent network without you. If I need to, you get an approval card first. On your phone that is one tap. Switching them off needs nothing from you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Exposure-on changes need the owner's approval | Automatic; approve from the approval card |

## Evidence

- `tests/unit/sec163-exposure-on-raise.test.ts`: reproduced the gap first (7 of 9 failed on the old code), then every exposure-on path is a raise, switching off stays free, the card carries only the switches, and the two direct writers open the card.
