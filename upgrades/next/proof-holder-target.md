<!-- bump: patch -->

## What Changed

The move check for sharing could never pass when the machine receiving the conversation was also the machine in charge of routing. Its test message was handed back to be delivered on that machine, and nothing delivered it, so the check always reported no reply. It now delivers the test message there, and says so plainly if that fails. Real messages were never affected: they have their own delivery step.

The check also credited a reply to the machine that logged it. A machine without the lease sends through the lease holder, so a correct reply read as coming from the wrong machine. It now reads the signed record of who wrote the reply.

## What to Tell Your User

Nothing to tell them. This fixes a test tool, not how conversations move.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| The move check works when the target also does the routing, and credits the true author | automatic; `POST /session-pool/rebalance-proof` |
