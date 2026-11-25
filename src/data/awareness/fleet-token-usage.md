---
title: Fleet token usage
---
When the owner asks for one token total across agents, check `GET /usage/fleet/status`. If enabled, direct the owner to What thinking costs → Fleet token usage. The dashboard reads `GET /usage/fleet` using its existing unlocked operator session. The ordinary agent token alone is refused. This view is off by default.

The fleet view combines only the agent pools explicitly configured for it. It reports partial and unavailable coverage alongside a single total. Keep the agent pool's ordinary `GET /usage/summary` separate when explaining the scope.
