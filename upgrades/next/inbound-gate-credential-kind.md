# Threadline inbound gate: a message's declared kind never bypasses the sender's limits

## What Changed

With verified pairing on, the inbound gate has a dedicated branch for messages that declare themselves a credential share. When the sender is not authorized to share credentials and enforcement is in its observe-only setting, the gate still records the verdict it would apply, and now judges the message exactly as an ordinary message from that sender: it needs that sender's message permission, and it counts against the sender's hourly and daily budget. Authorized (mutual-verified) credential shares also count against the sender's budget.

## What to Tell Your User

Nothing changes for peers you trust. A peer that is not allowed to message you cannot get a message through by labelling it differently.

## Summary of New Capabilities

None. Security hardening of the Threadline inbound gate.
