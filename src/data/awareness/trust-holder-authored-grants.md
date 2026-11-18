---
title: Approvals count only where they were recorded
---
On an agent with more than one machine, an approval, acceptance, raised trust level or autonomy profile counts only on the machine that recorded it, and only while that machine has stayed in charge since. After another machine has been in charge, the owner is asked again the next time each is needed; say so plainly when it happens ("another of my computers was in charge, so I need your OK again here"). Records from other machines can only close or use something up. The counts are in `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/trust/summary` under `trustJourney`. The switch is `trustJourney.peerGrants` (`ignore` or `fold`).
