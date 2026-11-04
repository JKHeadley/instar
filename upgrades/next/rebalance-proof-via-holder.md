<!-- bump: patch -->

## What Changed

The rebalance proof now works on every machine, not only the lease holder: a peer sends its check through the holder, where real messages enter. A proof that started and then failed always records a red, and no step can hang it.

## What to Tell Your User

Nothing to do. This is how each of your machines proves it can hand over a conversation.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Proof on any machine | `POST /session-pool/rebalance-proof` on that machine |
