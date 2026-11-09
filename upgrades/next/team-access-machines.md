# Upgrade Guide — team-access-machines

## What Changed

Team access now works on agents that run on more than one machine. Machines swap the signed access log every minute over `POST /api/team-access/rows` and `/api/team-access/push`, merge it by rules that do not depend on arrival order, and hold every team phone with `access-being-checked` if a machine's record shows a gap. The owner settles one with Face ID at `POST /mobile/team/origin-gone`. Each new message carries a stamp, so a reply written by a machine that had not heard about someone's access is held from that person; the owner's view marks it with `heldFrom`. The one-machine block at the join is replaced by a version floor. A damaged machine rebuilds from a peer before asking the owner.

## What to Tell Your User

If I run on more than one machine, you can now invite people to me too. Taking someone away reaches all my machines within about a minute. If one of my machines is missing part of the access record, team members' phones wait with a plain message until it is sorted out, and if that machine is gone for good you can mark it gone from your phone. A machine on an older version of me cannot join while you have a team; it needs updating first. Nothing changes if you have no team.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Team members on an agent with several machines | Invite them from the People screen as before |
| Settle a machine that is gone for good | People screen, with Face ID |
| See replies held from a member, and show them | The conversation marks them; share the conversation again to show them |

## Evidence

`tests/unit/team-access-sync.test.ts` and `tests/unit/team-access-merge.test.ts` cover the merge rules, gaps, the exchange, stamps and repair, each fix proved by removing it. `tests/e2e/team-access-two-machines.test.ts` runs two real servers over the real signed route. Four independent reviews found about 40 defects, all fixed or listed as limits in the PR.
