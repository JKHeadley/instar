# Gemini "Long Block" Escalation — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/e5a1de0b-4e83-4d53-9565-ca23fc04857a?sig=18315449f889314be1565b8f89a7a13bbe9b0182b0cb8c55a6d0a55ff0d70d14

When Gemini runs out of capacity, it tells Instar when to come back — sometimes "in 8 seconds,"
sometimes "in 13 hours." Instar already knows not to keep hammering Gemini during that window (it waits
politely instead). That's good.

The gap: it waited **silently**. If Gemini said "come back in 13 hours," the agent (or a mentee agent
it's supervising) would just be quietly unavailable for half a day, and nobody would know why.

This change adds a quiet watcher: if Gemini is blocked for longer than a set time (default 1 hour),
Instar raises **one** heads-up — "Gemini is capacity-blocked for about N hours" — so you actually know
the agent is waiting on a quota reset, not broken or stuck. Short blips stay silent; only long blocks
get flagged, and only once per block.

It changes nothing about how Gemini calls work — it just turns a silent wait into a visible one. Ships
off; you turn it on when you want it. There's also a `GET /gemini/capacity` you can check to see if
Gemini is currently blocked and for how long.

_Tier-1 fix · branch `echo/gemini-capacity-escalation` · 8 unit + 3 integration/e2e tests · completes
item-3's "escalate, not silently stall" half._
